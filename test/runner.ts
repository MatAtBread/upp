import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXAMPLES_DIR = path.join(__dirname, '../examples');
const RESULTS_DIR = path.join(__dirname, '../test-results');
const UPDATE_FLAG = process.argv.includes('--update');

if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.toLowerCase());
        });
    });
}

function getDiff(file1: string, content2: string): string {
    const tempFile = path.join(RESULTS_DIR, '.temp_output');
    fs.writeFileSync(tempFile, content2);
    try {
        const result = spawnSync('diff', ['-u', '--color=always', file1, tempFile], { encoding: 'utf8' });
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return result.stdout;
    } catch (e: any) {
        return "Diff failed: " + e.message;
    }
}

function normalizeOutput(actualOutput: string): string {
    // Remove absolute paths to make snapshots portable
    let normalized = actualOutput.split(process.cwd()).join('.');
    // Normalize /tmp/ccXXXX.o (masking the random part)
    normalized = normalized.replace(/\/tmp\/cc\w+\.o/g, '/tmp/ccXXXX.o');
    // Normalize any other absolute paths that might still be there from home dir
    const home = process.env.HOME;
    if (home) {
        normalized = normalized.split(home).join('~');
    }
    return normalized;
}

async function verifySnapshot(testName: string, actualOutput: string): Promise<boolean> {
    const snapshotPath = path.join(RESULTS_DIR, `${testName}.snap`);
    const normalizedOutput = normalizeOutput(actualOutput);

    if (!fs.existsSync(snapshotPath)) {
        console.log(`[PASS] ${testName} - Created new snapshot.`);
        fs.writeFileSync(snapshotPath, normalizedOutput);
        return true;
    }

    const existingOutput = fs.readFileSync(snapshotPath, 'utf8');
    if (normalizedOutput !== existingOutput) {
        console.log(`[FAIL] ${testName} differs from snapshot!`);
        console.log(getDiff(snapshotPath, normalizedOutput));

        let shouldUpdate = UPDATE_FLAG;
        if (!shouldUpdate && process.stdin.isTTY) {
            const answer = await ask(`Update snapshot for ${testName}? (y/n): `);
            if (answer === 'y') shouldUpdate = true;
        }

        if (shouldUpdate) {
            fs.writeFileSync(snapshotPath, normalizedOutput);
            console.log(`[UPDATE] Updated snapshot for ${testName}`);
            return true;
        } else {
            return false;
        }
    }

    console.log(`[PASS] ${testName}`);
    return true;
}

async function runTest(entryName: string): Promise<boolean> {
    const entryPath = path.join(EXAMPLES_DIR, entryName);

    // Invoke upp --test
    // Note: We use index.ts directly here. 
    // Node 24 with --experimental-strip-types will handle it.
    const run = spawnSync('node', ['--experimental-strip-types', 'index.ts', '--test', entryPath], { encoding: 'utf8' });
    const output = run.stdout + run.stderr;

    const testName = entryName.endsWith('.cup') ? entryName.slice(0, -4) : entryName;
    const isErrorTest = testName.startsWith('error_');

    const hasCompilationError = output.includes('==== COMPILATION ERROR ===');
    const hasMacroError = output.includes('Macro @') && output.includes('failed:');
    const hasGenericError = output.includes('error:');

    if (!isErrorTest && (hasCompilationError || hasMacroError || hasGenericError)) {
        console.log(`[FAIL] ${testName} contains UNEXPECTED ERROR!`);
        // We still verify snapshot to see the error details in diff if it matched before
        await verifySnapshot(testName, output);
        return false;
    }

    return await verifySnapshot(testName, output);
}

async function main() {
    const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    let entries: string[];

    if (args.length > 0) {
        entries = args.map(f => {
            let name = path.relative(EXAMPLES_DIR, path.resolve(f));
            if (name.startsWith('..')) name = path.basename(f);
            return name;
        });
    } else {
        const all = fs.readdirSync(EXAMPLES_DIR);
        entries = all.filter(f => {
            if (f === 'upp.json') return false;
            const p = path.join(EXAMPLES_DIR, f);
            const stat = fs.statSync(p);
            return f.endsWith('.cup') || (stat.isDirectory() && !f.startsWith('.'));
        });
    }

    console.log(`Found ${entries.length} tests.`);

    let allPassed = true;
    for (const entry of entries) {
        const passed = await runTest(entry);
        if (!passed) allPassed = false;
    }

    rl.close();
    if (!allPassed) {
        console.log('\nSome tests failed.');
        process.exit(1);
    } else {
        console.log('\nAll tests passed!');
    }
}

main();
