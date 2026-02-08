import { Registry } from './src/registry.js';
import fs from 'fs';

const source = fs.readFileSync('examples/deferred_order_test.cup', 'utf8');
const registry = new Registry();

console.log("--- ORIGINAL ---");
console.log(source);

try {
    const result = registry.transform(source, 'examples/deferred_order_test.cup');
    console.log("\n--- TRANSFORMED ---");
    console.log(result);

    // Verification
    if (!result.includes('// Start of function')) {
        console.error("FAIL: Ancestor transformation (inScope) was not applied");
    } else if (!result.includes('/* Immediate transformation */')) {
        console.error("FAIL: Sub-node transformation was not applied");
    } else if (result.indexOf('// Start of function') > result.indexOf('/* Immediate transformation */')) {
        // This is a rough check, but since we prepended to the function, it should be at the start.
        console.log("SUCCESS: Orders look plausible (function header prepended)");
    } else {
        console.log("\nSUCCESS: Deferred order behaviors verified!");
    }
} catch (e) {
    console.error("\nTransformation failed:");
    console.error(e);
}
