#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { Registry } from './src/registry.js';
import { DependencyCache } from './src/dependency_cache.js';
import { DiagnosticsManager } from './src/diagnostics.js';
import { parseArgs } from './src/cli.js';

const command = parseArgs(process.argv.slice(2));

if (!command.isUppCommand) {
    console.error("Usage: upp <compiler_command>");
    console.error("Example: upp gcc -c main.c -o main.o");
    process.exit(1);
}

const cache = new DependencyCache();

// 1. Process sources
// Identify common preprocessor args (exclude all sources, output flags, and dep flags)
const commonPrepArgs = [];
let skipNext = false;
for (let i = 1; i < command.fullCommand.length; i++) {
    const arg = command.fullCommand[i];
    if (skipNext) { skipNext = false; continue; }
    if (arg === '-o') { skipNext = true; continue; }
    if (arg === '-c' || arg === '-S' || arg === '-E') continue;
    // Filter out ANY source file identified by CLI
    if (command.sources.some(s => s.cFile === arg)) continue;
    if (arg.endsWith('.c')) continue;

    // Filter Dependency flags (we handle them specifically)
    if (arg === '-MD' || arg === '-MMD' || arg === '-MP') continue;
    if (arg === '-MF' || arg === '-MT' || arg === '-MQ') {
        skipNext = true;
        continue;
    }

    commonPrepArgs.push(arg);
}
// Add essential flags
commonPrepArgs.push('-E', '-P', '-x', 'c');

// Store extra dependencies collected from sub-files (e.g. #includes inside .hup)
let extraDeps = [];

/**
 * Runs the pre-processor on a specific file.
 * @param {string} filePath - Path to file.
 * @param {string[]} [customFlags=[]] - Additional flags (e.g. deps).
 * @returns {string} Pre-processed content.
 */
function preprocess(filePath, customFlags = []) {
    const args = [...commonPrepArgs, ...customFlags, filePath];
    return execSync(`${command.compiler} ${args.join(' ')}`, { encoding: 'utf8' });
}

for (const source of command.sources) {
    extraDeps = []; // Reset for each source
    if (fs.existsSync(source.absCupFile)) {
        try {
            // Run Pre-processor on main input with Main Dep Flags
            const preProcessed = preprocess(source.cupFile, command.depFlags);

            // Resolve config (simple search for upp.json)
            let loadedConfig = {};
            let lookupDir = path.dirname(source.absCupFile);
            while (true) {
                const configPath = path.join(lookupDir, 'upp.json');
                if (fs.existsSync(configPath)) {
                    try {
                        loadedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                        break;
                    } catch (e) { /* ignore */ }
                }
                const parent = path.dirname(lookupDir);
                if (parent === lookupDir) break;
                lookupDir = parent;
            }

            // Define UPP variable for expansion (directory of executable)
            // process.argv[1] is the script path (upp/index.js usually)
            const UPP_DIR = path.dirname(process.argv[1]);

            // Helper to expand variables
            const expandVars = (p) => p.replace('${UPP}', UPP_DIR);

            // Include Paths: source dir + CLI + config
            const configIncludesRaw = loadedConfig.include_paths || [];
            if (loadedConfig.includePaths) configIncludesRaw.push(...loadedConfig.includePaths);

            // Resolve config includes
            const resolvedConfigIncludes = configIncludesRaw.map(p => {
                 const expanded = expandVars(p);
                 return path.isAbsolute(expanded) ? expanded : path.resolve(lookupDir, expanded);
            });

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
            // Also load legacy std/*.upp if core not defined?
            // User intention seems to be explicit control.
            // But let's support loading 'async.hup' if listed.

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
                   // We must process it using loadDependency to ensure .h generation and caching
                   registry.loadDependency(foundPath);
                } else {
                    console.warn(`[upp] Warning: Core file '${coreFile}' not found in include paths.`);
                }
            }

            // Legacy fall back: if no core defined, try std/*.upp?
            // User explicitly requested removal of .upp convention.
            // If core is empty, we do nothing. Safe.

            // Process Macros
            registry.registerSource(preProcessed, source.absCupFile);
            const output = registry.process();

            // Write output to the .c file
            fs.writeFileSync(source.absCFile, output);

            // Dependency Tracking Logic (unchanged)
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
            // We append -I for each resolved path that isn't already there?
            // Compiler args are preserved. simple append is usually safe (last wins or additive).
            for (const inc of resolvedConfigIncludes) {
                // Check if already present? simpler to just add.
                // But we must add them to 'finalArgs' logic later.
                // We'll store them in 'command.additionalIncludes'?
                if (!command.additionalIncludes) command.additionalIncludes = [];
                command.additionalIncludes.push(inc);
            }

        } catch (e) {
            console.error(`[upp] Error processing ${source.cupFile}:`);
            console.error(e.message);
            process.exit(1);
        }
    }
}

// 2. Execute Original Compiler Command
// Strip dependency flags to prevent overwriting the .d file we just patched
// (The compiler would generate an empty .d file because it sees pre-processed input)
const finalArgs = [];
let skipNextFinal = false;
for (let i = 1; i < command.fullCommand.length; i++) {
    const arg = command.fullCommand[i];
    if (skipNextFinal) { skipNextFinal = false; continue; }

    // Check if this arg is in depFlags
    // We need to handle flags with arguments (like -MF file) correctly.
    // command.depFlags contains ALL parts (flags and values).
    // So we just check inclusion?
    // Limitation: if same string appears as other arg? Unlikely for -MD.
    // BUT 'file.d' might appear elsewhere?
    // command.depFlags is explicit list from CLI parsing.
    // We can filter by index if we tracked it, but simple inclusion is risky for values.
    // Better: Re-detect using same logic as CLI or assume depFlags set is unique enough?
    // Actually, distinct array approach is better.
    // Let's reuse the logic:
    if (arg === '-MD' || arg === '-MMD' || arg === '-MP') { // Added -MP handling
        continue;
    }
    if (arg === '-MF' || arg === '-MT' || arg === '-MQ') {
        skipNextFinal = true;
        continue;
    }
    finalArgs.push(arg);
}

// Append additional includes from upp.json
if (command.additionalIncludes) {
    for (const inc of command.additionalIncludes) {
        finalArgs.push('-I' + inc);
    }
}

// console.log(`[upp] Executing: ${command.compiler} ${finalArgs.join(' ')}`);
const child = spawnSync(command.compiler, finalArgs, { stdio: 'inherit' });
process.exit(child.status);
