const { Registry } = require('./registry');
const path = require('path');

const filePath = process.argv[2];

if (!filePath) {
    console.error("Usage: node index.js <file.c>");
    process.exit(1);
}

const registry = new Registry();
console.log(`Parsing ${filePath}...`);
registry.registerFile(path.resolve(filePath));

console.log("\nRegistered Macros:");
for (const [name, macro] of registry.macros) {
    console.log(`- ${name}: (${macro.params.join(', ')})`);
}

console.log("\nDetecting and Evaluating Macros...");
    const processedSource = registry.process();

    console.log('\n--- Processed Source Code ---');
    console.log(processedSource);
