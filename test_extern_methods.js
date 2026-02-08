import { Registry } from './src/registry.js';
import fs from 'fs';
import path from 'path';

async function test() {
    const registry = new Registry({
        filePath: path.resolve('examples/extern_methods/extern_methods_main.cup')
    });

    const sourceMain = fs.readFileSync('examples/extern_methods/extern_methods_main.cup', 'utf8');
    const sourceImpl = fs.readFileSync('examples/extern_methods/extern_methods_impl.cup', 'utf8');
    const sourceHup = fs.readFileSync('examples/extern_methods/extern_methods.hup', 'utf8');

    console.log("--- TRANSFORMING main.cup ---");
    const transformedMain = registry.transform(sourceMain, 'examples/extern_methods/extern_methods_main.cup');
    console.log(transformedMain);

    const registryImpl = new Registry({
        filePath: path.resolve('examples/extern_methods/extern_methods_impl.cup')
    });
    console.log("\n--- TRANSFORMING impl.cup ---");
    const transformedImpl = registryImpl.transform(sourceImpl, 'examples/extern_methods/extern_methods_impl.cup');
    console.log(transformedImpl);
}

test().catch(console.error);
