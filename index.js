#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Registry } from './src/registry.js';
import { resolveConfig } from './src/config_loader.js';
import { DependencyCache } from './src/dependency_cache.js';
import { DiagnosticsManager } from './src/diagnostics.js';
import { parseArgs } from './src/cli.js';

const options = parseArgs(process.argv.slice(2));

if (options.isHelp) {
    console.log("Usage: upp [options] <file.c>...");
    console.log("Options:");
    console.log("  -o <file>   Specify output file (only valid with single input)");
    console.log("  -w, --write Auto-generate output files");
    console.log("  -r, --run   Transpile, compile and run the input file(s)");
    console.log("  -I <path>   Add include path");
    process.exit(0);
}

const cache = new DependencyCache();

try {
    for (const absolutePath of options.inputFiles)
    {
    const dirName = path.dirname(absolutePath);
    const baseName = path.basename(absolutePath);
    const ext = path.extname(baseName).slice(1);
    const fileNameWithoutExt = path.parse(baseName).name;

    // 1. Resolve Configuration
    const config = resolveConfig(absolutePath);
    config.cache = cache;
    config.write = options.writeMode;
    config.stats = options.showStats;
    config.diagnostics = new DiagnosticsManager(config);
    const langConfig = (config.lang && config.lang[ext]) || {};

    /**
     * Executes a shell command with variable interpolation.
     * @param {string} cmd - The command string with ${VAR} placeholders.
     * @param {Object<string, string>} vars - Map of variable names to values.
     * @returns {string} The standard output of the command.
     */
    function runCommand(cmd, vars) {
        let finalCmd = cmd;
        for (const [key, value] of Object.entries(vars)) {
            finalCmd = finalCmd.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
        }
        try {
            return execSync(finalCmd, { cwd: dirName, encoding: 'utf8' });
        } catch (err) {
            console.error(`Command failed: ${finalCmd}`);
            console.error(err.message);
            throw err;
        }
    }

    const vars = {
        'INPUT': absolutePath,
        'BASENAME': fileNameWithoutExt,
        'FILENAME': baseName
    };

    // 2. Resolve Initial Source
    let initialSource;
    if (langConfig['pre-upp']) {
        initialSource = runCommand(langConfig['pre-upp'], vars);
    } else {
        initialSource = fs.readFileSync(absolutePath, 'utf8');
    }

    // 3. Initialize Registry & Macros
    const cliIncludePaths = options.includePaths;
    const configIncludePaths = config.includePaths || [];
    // CLI paths take precedence.
    // Also include the directory of the input file itself (implicitly).
    config.includePaths = [...new Set([dirName, ...cliIncludePaths, ...configIncludePaths])];
    const registry = new Registry(config);

    // Auto-load standard macros from 'std' directory next to index.js
    const stdDir = path.join(path.dirname(process.argv[1]), 'std'); // Approximate script loc?
    // process.argv[1] is the script path.
    // robust way for ESM? import.meta.url?
    // This file is built/run as node script.
    // use __dirname if available, or path derivation.
    // Since this project uses modules, __dirname is not available.
    // But we are in 'index.js'.
    // We can assume 'std' is in process.cwd()/std if running locally, or relative to this file.
    // For this context (user session), we know where it is: /home/matt/git/upp/std
    // Let's use the relative path './std'.
    const stdLibDir = path.resolve(path.dirname(process.argv[1]), 'std');

    if (fs.existsSync(stdLibDir)) {
        const stdFiles = fs.readdirSync(stdLibDir).filter(f => f.endsWith('.upp'));
        for (const f of stdFiles) {
             const fullPath = path.join(stdLibDir, f);
             // We use private _parse/scan methods or just registerSource?
             // registerSource overwrites this.sourceCode/filePath. We don't want that for the main file.
             // We want to load definitions into the macros map.
             // We can use 'loadDependency' if we expose it or use it indirectly?
             // But loadDependency checks cache and such.
             // Best way: manually read and scan.
             const src = fs.readFileSync(fullPath, 'utf8');
             const macros = registry.scanMacros(src, fullPath);
             for(const [name, m] of macros) registry.macros.set(name, m);

             // Also scan for includes in std lib? recursive?
             // registry.loadDependency(fullPath);
             // Ideally we treat std lib as dependencies we just load up front.
             // But loadDependency updates global state?
             // Registry methods work on 'this'.
             // Let's use loadDependency to be safe and complete,
             // BUT loadDependency might trigger writes if -w is on?
             // std libs shouldn't be rewritten.
             // The write check checks extension. .upp -> .out?
             // My implementation of write check handles .upp.
             // We should probably ensure we don't overwrite std lib.
             // For now, manual scan is safer for "built-ins".
        }
    }

    registry.registerSource(initialSource, absolutePath);

    // 4. Transformation Stage
    const processedSource = registry.process();

    // 5. Run Stage
    if (options.runMode) {
        const tempBaseName = `.temp_${fileNameWithoutExt}_${Math.random().toString(36).slice(2, 8)}`;
        const tempPath = path.join(dirName, `${tempBaseName}.${ext}`);
        const exePath = path.join(dirName, tempBaseName + (process.platform === 'win32' ? '.exe' : '.out'));

        fs.writeFileSync(tempPath, processedSource);

        const runVars = {
            ...vars,
            'OUTPUT': tempPath,
            'FILENAME': tempBaseName,
            'BASENAME': `${tempBaseName}.${ext}`
        };

        try {
            if (langConfig['compile']) {
                runCommand(langConfig['compile'], runVars);
            }
            if (langConfig['run']) {
                const output = runCommand(langConfig['run'], runVars);
                if (output) process.stdout.write(output);
            }
        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            // Cleanup potential executables
            [".exe", ".out", ""].forEach(ext => {
                const p = path.join(dirName, tempBaseName + ext);
                if (fs.existsSync(p) && p !== tempPath) fs.unlinkSync(p);
            });
        }
        continue; // Skip normal output stages
    }

    // 6. Post-upp Stage
    if (langConfig['post-upp']) {
        const outputPath = path.join(dirName, `upp.${baseName}`);
        fs.writeFileSync(outputPath, processedSource);

        const postVars = {
            ...vars,
            'OUTPUT': outputPath,
            'OUTPUT_BASENAME': fileNameWithoutExt
        };

        runCommand(langConfig['post-upp'], postVars);
    } else {
        if (options.outputFile) {
            fs.writeFileSync(options.outputFile, processedSource);
        } else if (config.write) {
            // Auto-generate output filename: remove .upp suffix if present, otherwise append .out?
            // The plan says "remove .upp extension".
            // If file is "foo.c.upp" -> "foo.c".
            // If file is "foo.c" -> ... maybe don't overwrite? default to same behavior?
            // Let's assume input files MUST be .upp to be auto-written, or we replace the extension.
            // Safe logic: if ends in .upp, strip it. If not, error or warn?
            // For now, let's verify pattern.
            // Auto-generate output filename: remove .upp suffix if present
            // .cup -> .c, .hup -> .h
            let outPath;
            if (absolutePath.endsWith('.hup')) {
                outPath = absolutePath.slice(0, -2); // .hup -> .h
            } else if (absolutePath.endsWith('.cup')) {
                outPath = absolutePath.slice(0, -2); // .cup -> .c
            } else if (absolutePath.endsWith('.upp')) {
                outPath = absolutePath.slice(0, -4);
            } else {
                console.warn(`Warning: Input file ${baseName} does not end in .upp/.cup/.hup. Appending .out`);
                outPath = absolutePath + ".out";
            }
            fs.writeFileSync(outPath, processedSource);
            // console.log(`Generated: ${path.relative(process.cwd(), outPath)}`);
        } else {
            console.log(`/* upp ${path.relative(process.cwd(), absolutePath)} */\n`);
            console.log(processedSource);
        }
    }
    }
} catch (err) {
    console.error(err);
    process.exit(1);
}
