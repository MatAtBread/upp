#!/home/matt/.nvm/versions/node/v20.20.0/bin/node

const { Registry } = require('./registry');
const { resolveConfig } = require('./config_loader');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const filePath = args[0];

if (!filePath) {
    console.error("Usage: node index.js <file.c>");
    process.exit(1);
}

const absolutePath = path.resolve(filePath);
const dirName = path.dirname(absolutePath);
const baseName = path.basename(absolutePath);
const ext = path.extname(baseName).slice(1);
const fileNameWithoutExt = path.parse(baseName).name;

// 1. Resolve Configuration
const config = resolveConfig(absolutePath);
const langConfig = (config.lang && config.lang[ext]) || {};

function runCommand(cmd, vars) {
    let finalCmd = cmd;
    for (const [key, value] of Object.entries(vars)) {
        finalCmd = finalCmd.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
    console.log(`Executing: ${finalCmd}`);
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
const registry = new Registry();
console.log(`Parsing ${filePath}...`);
registry.registerSource(initialSource, absolutePath);

// 4. Transformation Stage
console.log("\nRegistered Macros:");
for (const [name, macro] of registry.macros) {
    console.log(`- ${name}: (${macro.params.join(', ')})`);
}

console.log("\nDetecting and Evaluating Macros...");
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
    console.log('\n--- Processed Source Code ---');
    console.log(processedSource);
}
