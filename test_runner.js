
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXAMPLES_DIR = path.join(__dirname, 'examples');
const RESULTS_DIR = path.join(__dirname, 'test-results');
const UPDATE_FLAG = process.argv.includes('--update');

if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.toLowerCase());
        });
    });
}

function getDiff(file1, content2) {
    const tempFile = path.join(RESULTS_DIR, '.temp_output');
    fs.writeFileSync(tempFile, content2);
    // Use git diff if available for color, else plain diff
    try {
         const result = spawnSync('diff', ['-u', '--color=always', file1, tempFile], { encoding: 'utf8' });
         fs.unlinkSync(tempFile);
         return result.stdout;
    } catch (e) {
         return "Diff failed: " + e.message;
    }
}

// Ensure result directory exists for a file
function ensureResultDir(relativePath) {
    const dir = path.dirname(path.join(RESULTS_DIR, relativePath));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function verifySnapshot(relativePath, snapshotPath, actualOutput, label = "", isSuccess = true) {
    const taskLabel = label ? `(${label})` : "";

    // Normalize output? (Remove absolute paths to make snapshots portable)
    const normalizedOutput = actualOutput.split(process.cwd()).join('.');

    if (!fs.existsSync(snapshotPath)) {
        if (isSuccess) {
            console.log(`[PASS] ${relativePath} ${taskLabel} - Created new snapshot.`);
            fs.writeFileSync(snapshotPath, normalizedOutput);
            return true;
        } else {
            console.log(`[FAIL] ${relativePath} ${taskLabel} - No snapshot found. Creating new one.`);
            fs.writeFileSync(snapshotPath, normalizedOutput);
            return false;
        }
    }

    const existingOutput = fs.readFileSync(snapshotPath, 'utf8');
    if (normalizedOutput !== existingOutput) {
        console.log(`[FAIL] ${relativePath} ${taskLabel} differs from snapshot!`);
        console.log(getDiff(snapshotPath, normalizedOutput));

        let shouldUpdate = UPDATE_FLAG;
        if (!shouldUpdate && process.stdin.isTTY) {
            const answer = await ask(`Update snapshot for ${relativePath} ${taskLabel}? (y/n): `);
            if (answer === 'y') shouldUpdate = true;
        }

        if (shouldUpdate) {
            fs.writeFileSync(snapshotPath, normalizedOutput);
            console.log(`[UPDATE] Updated snapshot for ${relativePath} ${taskLabel}`);
            return true;
        } else {
            return false;
        }
    }

    console.log(`[PASS] ${relativePath} ${taskLabel}`);
    return true;
}

// Check if a file is an error test (by convention, e.g. ends with _error.cup)
function isErrorTest(filename) {
    return filename.includes('_error');
}

async function runTest(entryName) {
    const entryPath = path.join(EXAMPLES_DIR, entryName);
    const stat = fs.statSync(entryPath);
    const filesToDelete = [];

    // Identify Source Files
    let sourceFiles = [];
    let isSuite = false;
    let mainCupFileRaw = "";

    if (stat.isDirectory()) {
         isSuite = true;
         const files = fs.readdirSync(entryPath).filter(f => f.endsWith('.cup'));
         if (files.length === 0) return true;
         sourceFiles = files.map(f => path.join(entryName, f));
         mainCupFileRaw = sourceFiles[0]; // Assuming first logical cup file is main for checking
    } else {
        sourceFiles = [entryName];
        mainCupFileRaw = entryName;
    }

    // Determine target executable name
    const exeName = isSuite ? entryName : path.basename(entryName, '.cup');
    const exePath = path.join(EXAMPLES_DIR, `${exeName}.exe`);
    filesToDelete.push(exePath);

    // Command Construction
    // We assume input files like `examples/foo.cup` are passed to `upp cc` as `examples/foo.c`.
    const inputCFiles = sourceFiles.map(f => f.slice(0, -4) + '.c');

    // Arguments: upp cc examples/foo.c -o examples/foo.exe
    const uppCmdArgs = ['cc', ...inputCFiles.map(f => path.join('examples', f)), '-o', path.join('examples', path.basename(exePath))];

    // Capture Compilation Output
    // We want to verify:
    // 1. Exit code (0 usually, non-zero for error tests)
    // 2. Stdout/Stderr (for error messages)
    // 3. Generated .c content (<file>.c snapshot)

    let compileOutput = "";
    let isCompileError = false;

    try {
        const run = spawnSync('node', ['index.js', ...uppCmdArgs], { encoding: 'utf8' });
        compileOutput = (run.stdout || "") + (run.stderr || "");
        if (run.status !== 0) {
            isCompileError = true;
        }
    } catch (e) {
        compileOutput = e.message;
        isCompileError = true;
    }

    const testIsErrorExpected = isErrorTest(entryName);

    // Verify Compilation output text (usually empty on success, or error message)
    if (isCompileError) {
        const snapshotPath = path.join(RESULTS_DIR, entryName.slice(0, -4) + '.err');
        ensureResultDir(path.basename(snapshotPath));

        const passed = await verifySnapshot(entryName, snapshotPath, compileOutput, "compilation error", false);
        cleanup(filesToDelete);

        if (testIsErrorExpected) return passed;
        return false; // Unexpected error
    } else {
        if (testIsErrorExpected) {
             console.log(`[FAIL] ${entryName} expected compilation error but succeeded.`);
             return false;
        }
    }

    // Capture Generated .c Content for Snapshot
    for (let i = 0; i < sourceFiles.length; i++) {
        const cupFile = sourceFiles[i];
        const cFile = inputCFiles[i]; // relative to examples dir
        const absCFile = path.join(EXAMPLES_DIR, cFile);

        if (fs.existsSync(absCFile)) {
             const content = fs.readFileSync(absCFile, 'utf8');
             // Snapshot name: file.c
             const baseName = path.basename(cFile);
             const snapshotName = baseName;

             let resPath = "";
             if (isSuite) {
                 resPath = path.join(entryName, snapshotName);
             } else {
                 resPath = snapshotName;
             }
             ensureResultDir(resPath);

             const passed = await verifySnapshot(resPath, path.join(RESULTS_DIR, resPath), content, "gen code", true);
             if (!passed) {
                 cleanup(filesToDelete);
                 return false;
             }

             filesToDelete.push(absCFile);
        }
    }

    // Run Execution
    if (fs.existsSync(exePath)) {
        try {
            const run = spawnSync(exePath, [], { encoding: 'utf8', execution: 'pipe' });
            const runOutput = (run.stdout || "") + (run.stderr || "");

            const snapshotSuffix = '.run';
            const resPath = isSuite ? path.join(entryName, 'test.run') : entryName.slice(0, -4) + snapshotSuffix;
            ensureResultDir(resPath);

            const passed = await verifySnapshot(resPath, path.join(RESULTS_DIR, resPath), runOutput, "runtime", true);
            if (!passed) {
                cleanup(filesToDelete);
                return false;
            }
        } catch (e) {
             console.log(`[FAIL] Execution failed for ${entryName}: ${e.message}`);
             cleanup(filesToDelete);
             return false;
        }
    }

    cleanup(filesToDelete);
    return true;
}

function cleanup(files) {
    for (const f of files) {
        if (fs.existsSync(f)) {
            try { fs.unlinkSync(f); } catch (e) {}
        }
    }
}

async function main() {
    const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    let entries;

    if (args.length > 0) {
        entries = args.map(f => {
            return path.basename(f); // .cup file or dir
        });
    } else {
        const all = fs.readdirSync(EXAMPLES_DIR);
        entries = all.filter(f => {
            // if (f.startsWith('upp.')) return false;
            // if (f.endsWith('.exe')) return false;
            // if (f.endsWith('.c')) return false; // Ignore artifacts
            const p = path.join(EXAMPLES_DIR, f);
            const stat = fs.statSync(p);
            return f.endsWith('.cup') || stat.isDirectory();
        });
    }

    console.log(`Found ${entries.length} tests.`);

    let allPassed = true;
    for (const entry of entries) {
        if (entry === 'upp.json') continue;
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
