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
    console.log("  -I <path>   Add include path");
    process.exit(0);
}

const cache = new DependencyCache();

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
            process.exit(1);
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
    // CLI paths take precedence (or just append? usually search path order matters).
    // Let's put CLI paths FIRST so they are searched first.
    config.includePaths = [...new Set([...cliIncludePaths, ...configIncludePaths])];
    const registry = new Registry(config);
    registry.registerSource(initialSource, absolutePath);

    // 4. Transformation Stage
    const processedSource = registry.process();

    // 5. Post-upp Stage
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
            let outPath;
            if (absolutePath.endsWith('.upp')) {
                outPath = absolutePath.slice(0, -4);
            } else {
                console.warn(`Warning: Input file ${baseName} does not end in .upp. Appending .out`);
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
