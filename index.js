#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { Registry } from './src/registry.js';
import { DependencyCache } from './src/dependency_cache.js';
import { DiagnosticsManager } from './src/diagnostics.js';
import { parseArgs } from './src/cli.js';
import { resolveConfig } from './src/config_loader.js';

const command = parseArgs(process.argv.slice(2));

if (!command.isUppCommand) {
    console.error("Usage: upp <compiler_command>");
    console.error("Example: upp gcc -c main.c -o main.o");
    console.error("Support: upp --transpile <file.cup>");
    process.exit(1);
}

// Global state across transpilations
const cache = new DependencyCache();
let extraDeps = []; // Collected from -M flags during preprocessing

function preprocess(filePath, extraFlags = []) {
    const compiler = command.compiler || 'cc';
    const flags = [...extraFlags, '-E', '-P', '-C', '-x', 'c'].join(' ');
    try {
        const cmd = `${compiler} ${flags} "${filePath}"`;
        return execSync(cmd, { encoding: 'utf8' });
    } catch (e) {
        process.exit(1);
    }
}

// Helper for core transpilation of a single file
function transpileOne(sourceFile, outputCFile = null) {
    const absSource = path.resolve(sourceFile);
    const preProcessed = preprocess(absSource, command.depFlags || []);
    const loadedConfig = resolveConfig(absSource);

    const resolvedConfigIncludes = loadedConfig.includePaths || [];
    const finalIncludePaths = [
        path.dirname(absSource),
        ...resolvedConfigIncludes,
        ...(command.includePaths || [])
    ];

    const config = {
        cache,
        includePaths: finalIncludePaths,
        stdPath: path.join(path.dirname(new URL(import.meta.url).pathname), 'std'),
        diagnostics: new DiagnosticsManager({}),
        preprocess: (file) => {
            // ... same logic as below but simplified or shared ...
            return preprocess(file);
        }
    };
    const registry = new Registry(config);
    const coreFiles = loadedConfig.core || [];
    for (const coreFile of coreFiles) {
        let foundPath = null;
        for (const inc of finalIncludePaths) {
            const p = path.join(inc, coreFile);
            if (fs.existsSync(p)) { foundPath = p; break; }
        }
        if (foundPath) registry.loadDependency(foundPath);
    }

    const output = registry.transform(preProcessed, absSource);

    // Support materialization for the root file if requested by a macro (like @package)
    if (registry.shouldMaterializeDependency) {
        let outputPath = null;
        if (absSource.endsWith('.cup')) outputPath = absSource.slice(0, -4) + '.c';
        else if (absSource.endsWith('.hup')) outputPath = absSource.slice(0, -4) + '.h';

        if (outputPath) {
            fs.writeFileSync(outputPath, output);
        }
    }

    if (outputCFile) {
        fs.writeFileSync(outputCFile, output);
        return output;
    } else {
        return output;
    }
}

if (command.mode === 'transpile' || command.mode === 'ast') {
    try {
        if (command.mode === 'ast') {
            const absSource = path.resolve(command.file);
            const preProcessed = preprocess(absSource, command.depFlags || []);
            const registry = new Registry({ diagnostics: new DiagnosticsManager({}) });
            const tree = registry._parse(preProcessed);
            console.log(tree.rootNode.toString());
            process.exit(0);
        }
        const output = transpileOne(command.file);
        process.stdout.write(output);
        process.exit(0);
    } catch (e) {
        console.error(`[upp] Error: ${e.message}`);
        process.exit(1);
    }
}

for (const source of command.sources) {
    extraDeps = []; // Reset for each source
    if (fs.existsSync(source.absCupFile)) {
        try {
            // Run Pre-processor on main input with Main Dep Flags
            const preProcessed = preprocess(source.cupFile, command.depFlags);

            // Resolve config (Search up tree for upp.json, supports extends and UPP fallback)
            const loadedConfig = resolveConfig(source.absCupFile);

            // Include Paths: source dir + config (already resolved) + CLI
            const resolvedConfigIncludes = loadedConfig.includePaths || [];
            if (loadedConfig.includePaths) resolvedConfigIncludes.push(...loadedConfig.includePaths);

            // Final Include Paths (prioritize config)
            const finalIncludePaths = [
                path.dirname(source.absCupFile), // Implicit sibling lookup
                ...resolvedConfigIncludes,
                ...(command.includePaths || [])
            ];

            // Initialize Registry
            const config = {
                cache,
                includePaths: finalIncludePaths,
                diagnostics: new DiagnosticsManager({}),
                preprocess: (file) => {
                    // Same preprocess logic as before...
                    if (command.depFlags.length > 0) {
                        const tempD = path.join(path.dirname(source.absCFile), `.upp_temp_${Math.random().toString(36).slice(2)}.d`);
                        const flags = ['-MD', '-MF', tempD];
                        try {
                            const out = preprocess(file, flags);
                            if (fs.existsSync(tempD)) {
                                const content = fs.readFileSync(tempD, 'utf8');
                                const match = content.match(/^[^:]+:(.*)/s);
                                if (match) { extraDeps.push(match[1]); }
                                fs.unlinkSync(tempD);
                            }
                            return out;
                        } catch (e) {
                            if (fs.existsSync(tempD)) fs.unlinkSync(tempD);
                            throw e;
                        }
                    }
                    return preprocess(file);
                }
            };
            const registry = new Registry(config);

            // Core Loading (from config.core)
            const coreFiles = loadedConfig.core || [];

            for (const coreFile of coreFiles) {
                // Find file in include paths
                let foundPath = null;
                for (const inc of finalIncludePaths) {
                    const p = path.join(inc, coreFile);
                    if (fs.existsSync(p)) {
                        foundPath = p;
                        break;
                    }
                }

                if (foundPath) {
                    registry.loadDependency(foundPath);
                } else {
                    console.warn(`[upp] Warning: Core file '${coreFile}' not found in include paths.`);
                }
            }

            // Process
            const output = registry.transform(preProcessed, source.absCupFile);

            // Write output to the .c file
            fs.writeFileSync(source.absCFile, output);

            // Dependency Tracking Logic
            if (command.depFlags.length > 0) {
                let dFile = command.depOutputFile;
                if (!dFile) {
                    const parsed = path.parse(source.cupFile);
                    dFile = path.join(parsed.dir, parsed.name + '.d');
                }

                if (dFile && fs.existsSync(dFile)) {
                    const loadedHups = Array.from(registry.loadedDependencies).map(d => ` \\\n ${d}`).join('');
                    const transitive = extraDeps.join('');

                    const content = fs.readFileSync(dFile, 'utf8');
                    const targetMatch = content.match(/^([^:]+):/);
                    if (targetMatch) {
                        const target = targetMatch[1].trim();
                        fs.appendFileSync(dFile, `\n${target}:${loadedHups}${transitive}\n`);
                    }
                }
            }

            // Add resolved include paths to the FINAL compiler command so it can find generated headers
            if (!command.additionalIncludes) command.additionalIncludes = [];
            for (const inc of resolvedConfigIncludes) {
                command.additionalIncludes.push(inc);
            }

        } catch (e) {
            console.error(`[upp] Error processing ${source.cupFile}:`);
            console.error(e.message);
            process.exit(1);
        }
    }
}

// Final Step: Invoke the real compiler
// We need to swap all .cup entries in the original command with their .c counterparts
const finalArgs = command.fullCommand.slice(1).map(arg => {
    const source = command.sources.find(s => s.cupFile === arg || s.absCupFile === path.resolve(arg));
    if (source) return source.cFile;
    return arg;
});

// Append additional include paths from config
if (command.additionalIncludes) {
    for (const inc of command.additionalIncludes) {
        finalArgs.push('-I', inc);
    }
}

const run = spawnSync(command.compiler, finalArgs, { stdio: 'inherit' });
process.exit(run.status);
