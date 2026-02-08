import { Registry } from './src/registry.js';
import fs from 'fs';

const source = fs.readFileSync('examples/return_values_test.cup', 'utf8');
const registry = new Registry();

console.log("--- ORIGINAL ---");
console.log(source);

try {
    const result = registry.transform(source, 'examples/return_values_test.cup');
    console.log("\n--- TRANSFORMED ---");
    console.log(result);

    // Verification
    if (!result.includes('int replaced = 42;')) {
        console.error("FAIL: @Replace(42) was not replaced correctly");
    } else if (result.includes('@Delete()')) {
        console.error("FAIL: @Delete() was not deleted");
    } else if (!result.includes('/*@Ignore()*/')) {
        console.error("FAIL: @Ignore() was not preserved as a comment");
    } else {
        console.log("\nSUCCESS: All return value behaviors verified!");
    }
} catch (e) {
    console.error("\nTransformation failed:");
    console.error(e);
}
