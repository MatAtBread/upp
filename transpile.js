#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Registry } from './src/registry.js';
import { DependencyCache } from './src/dependency_cache.js';
import { DiagnosticsManager } from './src/diagnostics.js';
import { resolveConfig } from './src/config_loader.js';

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

const cache = new DependencyCache();
const diagnostics = new DiagnosticsManager({});

// 1. Resolve Config (Search up tree for upp.json, supports extends and UPP fallback)
const loadedConfig = resolveConfig(absCupFile);

const configIncludesRaw = loadedConfig.includePaths || [];
if (loadedConfig.includePaths) configIncludesRaw.push(...loadedConfig.includePaths);

const finalIncludePaths = [
    path.dirname(absCupFile),
    ...configIncludesRaw
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

const preProcessed = cupFile.endsWith('.cup') || cupFile.endsWith('.hup') ? fs.readFileSync(absCupFile, 'utf8') : preprocess(absCupFile);

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
const output = registry.transform(preProcessed, absCupFile);

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
