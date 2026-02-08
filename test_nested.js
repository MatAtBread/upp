import { Registry } from './src/registry.js';
import fs from 'fs';

const source = fs.readFileSync('examples/nested_test.cup', 'utf8');
const registry = new Registry();

console.log("--- ORIGINAL ---");
console.log(source);

try {
    const result = registry.transform(source, 'examples/nested_test.cup');
    console.log("\n--- TRANSFORMED ---");
    console.log(result);
} catch (e) {
    console.error("\nTransformation failed:");
    console.error(e);
}
