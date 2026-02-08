import { Registry } from './src/registry.js';
import fs from 'fs';

const reg = new Registry({ filePath: 'examples/refactor_test.cup' });
const source = fs.readFileSync('examples/refactor_test.cup', 'utf8');

console.log("--- ORIGINAL ---");
console.log(source);

try {
    const result = reg.transform(source, 'examples/refactor_test.cup');
    console.log("\n--- TRANSFORMED ---");
    console.log(result);
} catch (e) {
    console.error("Transformation failed:");
    console.error(e);
}
