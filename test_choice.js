import { Registry } from './src/registry.js';
import fs from 'fs';

const source = fs.readFileSync('examples/choice_test.cup', 'utf8');
const registry = new Registry();

console.log("--- ORIGINAL ---");
console.log(source);

try {
    const result = registry.transform(source, 'examples/choice_test.cup');
    console.log("\n--- TRANSFORMED ---");
    console.log(result);

    // Verification
    if (result.includes('if (x)') && result.includes('else')) {
        console.log("\nSUCCESS: @choice expanded correctly!");
    } else {
        console.error("\nFAIL: @choice expansion incorrect");
    }
} catch (e) {
    console.error("\nTransformation failed:");
    console.error(e);
}
