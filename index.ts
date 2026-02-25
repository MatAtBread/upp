#!/usr/bin/env node --experimental-strip-types

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import type { MaterializeOptions } from './src/registry.ts';
import { Registry } from './src/registry.ts';
import { DependencyCache } from './src/dependency_cache.ts';
import { DiagnosticsManager } from './src/diagnostics.ts';
import { parseArgs } from './src/cli.ts';
import { resolveConfig } from './src/config_loader.ts';
import type { CompilerCommand, SourceInfo } from './src/cli.ts';

const command: CompilerCommand = parseArgs(process.argv.slice(2));

if (!command.isUppCommand) {
    console.error("Usage: upp [--transoile|--test] <compiler_command>");
    console.error("Example: upp gcc -c main.c -o main.o");
    console.error("Transpile: upp --transpile <file.cup>");
    console.error("Test: upp --test <file.cup>");
    process.exit(1);
}

// Global state across transpilations
const projectRoot = path.dirname(new URL(import.meta.url).pathname);
const stdPath = path.join(projectRoot, 'std');
const cache = new DependencyCache();
let extraDeps: string[] = []; // Collected from -M flags during preprocessing

function preprocess(filePath: string, extraFlags: string[] = [], includePaths: string[] = []): string {
    const compiler = command.compiler || 'cc';
    const iFlags = includePaths.map(p => `-I"${p}"`).join(' ');
    const flags = [...extraFlags, '-E', '-P', '-C', '-x', 'c'].join(' ');
    try {
        const cmd = `${compiler} ${flags} ${iFlags} "${filePath}"`;
        return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
        if (e.stderr) {
            console.error(e.stderr.toString());
        }
        process.exit(1);
        throw e; // Unreachable but for types
    }
}

// Shared: resolve the final include path list for a given source file.
function resolveFinalIncludePaths(absSource: string): { finalIncludePaths: string[]; loadedConfig: ReturnType<typeof resolveConfig> } {
    const loadedConfig = resolveConfig(absSource);
    const resolvedConfigIncludes = loadedConfig.includePaths || [];
    const finalIncludePaths = [
        path.dirname(absSource),
        ...resolvedConfigIncludes,
        ...(command.includePaths || []),
        stdPath,
        projectRoot
    ];
    return { finalIncludePaths, loadedConfig };
}

// Shared: build a configured Registry for a source file and load its core dependencies.
function buildRegistry(
    finalIncludePaths: string[],
    loadedConfig: ReturnType<typeof resolveConfig>,
    onMaterialize: ((p: string, content: string, opts: MaterializeOptions) => void) | undefined,
    preprocessFn: (file: string) => string
): Registry {
    const config = {
        cache,
        includePaths: finalIncludePaths,
        stdPath,
        diagnostics: new DiagnosticsManager({}),
        onMaterialize,
        preprocess: preprocessFn
    };
    const registry = new Registry(config);
    const coreFiles = loadedConfig.core || [];
    for (const coreFile of coreFiles) {
        let foundPath: string | null = null;
        for (const inc of finalIncludePaths) {
            const p = path.join(inc, coreFile);
            if (fs.existsSync(p)) { foundPath = p; break; }
        }
        if (foundPath) {
            registry.loadDependency(foundPath);
        } else {
            console.warn(`[upp] Warning: Core file '${coreFile}' not found in include paths.`);
        }
    }
    return registry;
}

// Shared: create an onMaterialize handler that merges results into the given maps.
function makeMaterializationHandler(
    materializations: Map<string, string>,
    authoritativeMaterials: Set<string>,
    writeThrough: boolean = false
): (p: string, content: string, opts: MaterializeOptions) => void {
    return (p: string, content: string, options: MaterializeOptions) => {
        if (materializations.has(p)) {
            const existing = materializations.get(p);
            if (existing === content) return;

            // Authoritative Win Logic:
            if (options.isAuthoritative && !authoritativeMaterials.has(p)) {
                materializations.set(p, content);
                authoritativeMaterials.add(p);
                if (writeThrough) fs.writeFileSync(p, content);
                return;
            }

            if (authoritativeMaterials.has(p) && !options.isAuthoritative) {
                // Ignored: a consumer pass trying to overwrite an already-established authoritative version
                return;
            }

            throw new Error(`Conflicting materialization detected for ${p}. Different results produced for the same file in different parts of the project.`);
        }
        materializations.set(p, content);
        if (options.isAuthoritative) authoritativeMaterials.add(p);
        if (writeThrough) fs.writeFileSync(p, content);
    };
}

if (command.mode === 'transpile' || command.mode === 'ast' || command.mode === 'test') {
    try {
        const materializations = new Map<string, string>();
        const authoritativeMaterials = new Set<string>();
        const expandedFiles: string[] = [];

        // 1. Expand directories into .cup files
        if (command.files) {
            for (const f of command.files) {
                const stat = fs.statSync(f);
                if (stat.isDirectory()) {
                    const files = fs.readdirSync(f).filter(file => file.endsWith('.cup'));
                    for (const cupFile of files) {
                        expandedFiles.push(path.join(f, cupFile));
                    }
                } else {
                    expandedFiles.push(f);
                }
            }
        }

        if (command.mode === 'ast') {
            const absSource = path.resolve(expandedFiles[0]);
            const preProcessed = preprocess(absSource, command.depFlags || [], command.includePaths || []);
            const registry = new Registry({ diagnostics: new DiagnosticsManager({}) });
            const tree = registry.parser.parse(preProcessed);
            console.log(tree.rootNode.toString());
            process.exit(0);
        }

        let mainOutput = "";

        for (const absSource of expandedFiles) {
            const { finalIncludePaths, loadedConfig } = resolveFinalIncludePaths(absSource);
            const preProcessed = preprocess(absSource, command.depFlags || [], finalIncludePaths);
            const onMaterialize = makeMaterializationHandler(materializations, authoritativeMaterials);
            const registry = buildRegistry(
                finalIncludePaths,
                loadedConfig,
                onMaterialize,
                (file) => preprocess(file, [], finalIncludePaths)
            );

            const output = registry.transform(preProcessed, absSource);

            let mainOutputPath: string | null = null;
            if (absSource.endsWith('.cup')) mainOutputPath = absSource.slice(0, -4) + '.c';
            else if (absSource.endsWith('.hup')) mainOutputPath = absSource.slice(0, -4) + '.h';

            if (mainOutputPath) {
                materializations.set(mainOutputPath, output);
            }
            if (absSource === expandedFiles[0]) {
                mainOutput = output;
            }
        }

        if (command.mode === 'test') {
            // 1. Print all materialized files
            const sortedPaths = Array.from(materializations.keys()).sort();
            for (const p of sortedPaths) {
                const content = materializations.get(p)!;
                const relPath = path.relative(process.cwd(), p);
                console.log(`==== ${relPath} ===`);
                console.log(content);
            }

            // 2. Prepare for compilation
            const compiler = command.compiler || 'cc';
            const firstFile = expandedFiles[0];
            const exePath = firstFile.slice(0, -4) + '.exe';
            const cFiles = Array.from(materializations.keys()).filter(p => p.endsWith('.c'));

            // Write to disk for the real compiler
            for (const [p, content] of materializations) {
                fs.writeFileSync(p, content);
            }

            // Gather all include paths for the compiler
            const allIncludePaths = new Set<string>();
            for (const f of expandedFiles) {
                const loaded = resolveConfig(f);
                allIncludePaths.add(path.dirname(f));
                (loaded.includePaths || []).forEach(inc => allIncludePaths.add(path.resolve(path.dirname(f), inc)));
            }
            allIncludePaths.add(stdPath);
            allIncludePaths.add(projectRoot);

            const compileArgs = [...cFiles, '-o', exePath, ...Array.from(allIncludePaths).map(p => `-I${p}`)];
            const compile = spawnSync(compiler, compileArgs, { encoding: 'utf8' });

            if (compile.status !== 0) {
                console.log("==== COMPILATION ERROR ===");
                console.log(compile.stdout + compile.stderr);
            } else {
                // 3. Run
                const run = spawnSync(exePath, [], { encoding: 'utf8' });
                console.log("==== RUN OUTPUT ===");
                console.log(run.stdout + run.stderr);
            }

            // Cleanup
            if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
            for (const p of materializations.keys()) {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            }
            process.exit(0);
        } else {
            // Transpile mode: output all materialized files to disk
            for (const [p, content] of materializations) {
                fs.writeFileSync(p, content);
            }
            // Also output the main file content to stdout (current behavior preserved)
            process.stdout.write(mainOutput);
            process.exit(0);
        }
    } catch (e: unknown) {
        console.error(`[upp] Error:`);
        console.error(e);
        process.exit(1);
    }
}

// =========================================================================================
// STANDARD COMPILE MODE
// =========================================================================================

const materializations = new Map<string, string>();
const authoritativeMaterials = new Set<string>();

if (command.sources) {
    for (const source of command.sources) {
        extraDeps = []; // Reset for each source
        if (fs.existsSync(source.absCupFile)) {
            try {
                const { finalIncludePaths, loadedConfig } = resolveFinalIncludePaths(source.absCupFile);

                // Add resolved include paths for the compiler
                if (!command.additionalIncludes) command.additionalIncludes = [];
                for (const inc of (loadedConfig.includePaths || [])) {
                    command.additionalIncludes.push(inc);
                }

                // Build the preprocess function: with dep-tracking if -M flags are present
                const preprocessFn = (file: string): string => {
                    if (command.depFlags && command.depFlags.length > 0) {
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
                    return preprocess(file, [], finalIncludePaths);
                };

                const preProcessed = preprocess(source.cupFile, command.depFlags, finalIncludePaths);
                const onMaterialize = makeMaterializationHandler(materializations, authoritativeMaterials, /* writeThrough */ true);
                const registry = buildRegistry(finalIncludePaths, loadedConfig, onMaterialize, preprocessFn);

                const output = registry.transform(preProcessed, source.absCupFile);

                // Write output to the .c file
                fs.writeFileSync(source.absCFile, output);

                // Dependency Tracking
                if (command.depFlags && command.depFlags.length > 0) {
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

            } catch (e: any) {
                console.error(`[upp] Error processing ${source.cupFile}:`);
                console.error(e.message ?? e);
                process.exit(1);
            }
        }
    }
}

// Final Step: Invoke the real compiler
// We need to swap all .cup entries in the original command with their .c counterparts
const finalArgs = (command.fullCommand || []).slice(1).map(arg => {
    const source = (command.sources || []).find(s => s.cupFile === arg || s.absCupFile === path.resolve(arg));
    if (source) return source.cFile;
    return arg;
});

// Append additional include paths from config
if (command.additionalIncludes) {
    for (const inc of command.additionalIncludes) {
        finalArgs.push('-I', inc);
    }
}

const run = spawnSync(command.compiler || 'cc', finalArgs, { stdio: 'inherit' });
if (run.status !== null) {
    process.exit(run.status);
} else {
    process.exit(1); // Compilation killed/failed
}
