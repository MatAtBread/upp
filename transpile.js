#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Registry } from './src/registry.js';
import { DependencyCache } from './src/dependency_cache.js';
import { DiagnosticsManager } from './src/diagnostics.js';

const cupFile = process.argv[2];
if (!cupFile) {
    console.error("Usage: node transpile.js <file.cup>");
    process.exit(1);
}

const absCupFile = path.resolve(cupFile);
if (!fs.existsSync(absCupFile)) {
    console.error(`File not found: ${absCupFile}`);
    process.exit(1);
}

const UPP_DIR = path.dirname(new URL(import.meta.url).pathname);
const cache = new DependencyCache();
const diagnostics = new DiagnosticsManager({});

// 1. Resolve Config (mimicking index.js)
let loadedConfig = {};
let lookupDir = path.dirname(absCupFile);
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

const expandVars = (p) => p.replace('${UPP}', UPP_DIR);
const configIncludesRaw = loadedConfig.include_paths || loadedConfig.includePaths || [];
const resolvedConfigIncludes = configIncludesRaw.map(p => {
    const expanded = expandVars(p);
    return path.isAbsolute(expanded) ? expanded : path.resolve(lookupDir, expanded);
});

const finalIncludePaths = [
    path.dirname(absCupFile),
    ...resolvedConfigIncludes
];

// 2. Pre-process
function preprocess(filePath) {
    // Simple preprocessing - just -E -P -x c
    try {
        const cmd = `gcc -E -P -x c "${filePath}"`;
        return execSync(cmd, { encoding: 'utf8' });
    } catch (e) {
        console.error(`Preprocessor error: ${e.message}`);
        process.exit(1);
    }
}

const preProcessed = preprocess(absCupFile);

// 3. Initialize Registry
const config = {
    cache,
    includePaths: finalIncludePaths,
    diagnostics,
    preprocess: (file) => preprocess(file)
};
const registry = new Registry(config);

// 4. Load Core Macros
const coreFiles = loadedConfig.core || [];
for (const coreFile of coreFiles) {
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
    }
}

// 5. Transpile
registry.registerSource(preProcessed, absCupFile);
const output = registry.process();

// 6. Report
console.log("========================================");
console.log(`FILE: ${cupFile}`);
console.log("========================================");
console.log(output);

// Also report any generated .h files (dependencies with transforms)
const deps = Array.from(registry.loadedDependencies);
for (const d of deps) {
    const hPath = d.endsWith('.cup') ? d.slice(0, -4) + '.h' : (d.endsWith('.hup') ? d.slice(0, -4) + '.h' : null);
    if (hPath && fs.existsSync(hPath)) {
        console.log("\n========================================");
        console.log(`GENERATED HEADER: ${path.basename(hPath)} (from ${path.basename(d)})`);
        console.log("========================================");
        console.log(fs.readFileSync(hPath, 'utf8'));
    }
}
console.log("========================================");
