import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { resolveConfig } from './src/config_loader.js';

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
    const result = spawnSync('diff', ['-u', '--color=always', file1, tempFile], { encoding: 'utf8' });
    fs.unlinkSync(tempFile);
    return result.stdout;
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
    if (!fs.existsSync(snapshotPath)) {
        if (isSuccess) {
            console.log(`[PASS] ${relativePath} ${taskLabel} - Created new snapshot.`);
            fs.writeFileSync(snapshotPath, actualOutput);
            return true;
        } else {
            console.log(`[FAIL] ${relativePath} ${taskLabel} - No snapshot found. Creating new one.`);
            fs.writeFileSync(snapshotPath, actualOutput);
            return false;
        }
    }

    const existingOutput = fs.readFileSync(snapshotPath, 'utf8');
    if (actualOutput !== existingOutput) {
        console.log(`[FAIL] ${relativePath} ${taskLabel} differs from snapshot!`);
        console.log(getDiff(snapshotPath, actualOutput));

        let shouldUpdate = UPDATE_FLAG;
        if (!shouldUpdate && process.stdin.isTTY) {
            const answer = await ask(`Update snapshot for ${relativePath} ${taskLabel}? (y/n): `);
            if (answer === 'y') shouldUpdate = true;
        }

        if (shouldUpdate) {
            fs.writeFileSync(snapshotPath, actualOutput);
            console.log(`[UPDATE] Updated snapshot for ${relativePath} ${taskLabel}`);
            return true;
        } else {
            return false;
        }
    }

    console.log(`[PASS] ${relativePath} ${taskLabel}`);
    return true;
}

// Step 1: Run UPP transformation and verify snapshot
async function runUppTransformation(relativePath) {
    const filePath = path.join(EXAMPLES_DIR, relativePath);
    ensureResultDir(relativePath);
    const baseName = path.basename(relativePath);

    let output;
    let isError = false;
    let snapshotPath = path.join(RESULTS_DIR, relativePath);

    try {
        const run = spawnSync('node', ['index.js', filePath], { encoding: 'utf8' });
        output = (run.stdout || "") + (run.stderr || "");

        // 1. Check if it's an error state
        if (run.status !== 0 || (run.stderr?.length && !run.stdout?.trim().length)) {
             isError = true;
             snapshotPath = snapshotPath + '.err';
        }
    } catch (err) {
        output = err.message + (err.stack ? "\n" + err.stack : "");
        isError = true;
        snapshotPath = snapshotPath + '.err';
    }

    const passed = await verifySnapshot(relativePath, snapshotPath, output, "", !isError);

    // Write output for compilation if it passed and wasn't intended to be an error
    let outputPath = null;
    if (passed && !isError) {
        outputPath = path.join(path.dirname(filePath), `upp.${path.basename(filePath)}`);
        fs.writeFileSync(outputPath, output);
    }

    return { pass: passed, compilationReady: passed && !isError, outputPath };
}


async function runTest(entryName) {
    const entryPath = path.join(EXAMPLES_DIR, entryName);
    const stat = fs.statSync(entryPath);
    const filesToDelete = [];

    let sourceFiles = [];
    let isSuite = false;

    if (stat.isDirectory()) {
         isSuite = true;
         // Find all .c files in the directory
         const files = fs.readdirSync(entryPath).filter(f => f.endsWith('.c') && !f.startsWith('upp.'));
         if (files.length === 0) return true; // Empty suite
         sourceFiles = files.map(f => path.join(entryName, f));
    } else {
        sourceFiles = [entryName];
    }

    // 1. Transform all files
    const transformedFiles = [];
    let compilationReady = true;

    for (const file of sourceFiles) {
        const res = await runUppTransformation(file);

        if (res.outputPath) {
            transformedFiles.push(res.outputPath);
            filesToDelete.push(res.outputPath);
        }

        if (!res.pass) {
            cleanup(filesToDelete);
            return false;
        }

        if (!res.compilationReady) {
            compilationReady = false;
        }
    }

    if (!compilationReady) {
        cleanup(filesToDelete);
        return true; // Passed snapshot checks, but not runnable
    }

    // 2. Compile and Run
    // Config context:
    const mainFileShort = sourceFiles[0];
    const mainFilePath = path.join(EXAMPLES_DIR, mainFileShort);
    const config = resolveConfig(mainFilePath);
    const ext = path.extname(mainFilePath).slice(1);
    const langConfig = (config.lang && config.lang[ext]) || {};

    if (langConfig.compile && langConfig.run) {
         // HACK: We will join all input paths and replace ${INPUT} with the list.
         const inputList = transformedFiles.join(' ');

         // Output executable path
         const exeName = isSuite ? entryName : path.basename(entryName, '.c');
         const exePath = path.join(EXAMPLES_DIR, `${exeName}.exe`);
         filesToDelete.push(exePath);

         const vars = {
            'INPUT': mainFilePath,
            'BASENAME': exeName,
            'FILENAME': exeName,
            'OUTPUT': inputList,
            'OUTPUT_BASENAME': exeName
        };

        function runCmd(cmd) {
            let finalCmd = cmd;
            for (const [key, value] of Object.entries(vars)) {
                finalCmd = finalCmd.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
            }
            return finalCmd;
        }

        // Helper to get consistent error snapshot path
        function getErrorSnapshotPath() {
             return isSuite ? path.join(RESULTS_DIR, entryName, 'test.err') : path.join(RESULTS_DIR, entryName + '.err');
        }

        // Compile
        const compileCmd = runCmd(langConfig.compile);
        try {
            execSync(compileCmd, { cwd: EXAMPLES_DIR, encoding: 'utf8', stdio: 'pipe' });
        } catch (err) {
            const compileOutput = (err.stdout || "") + (err.stderr || "");
            const snapshotPath = getErrorSnapshotPath();
            ensureResultDir(isSuite ? path.join(entryName, 'test.err') : entryName + '.err');
            const passed = await verifySnapshot(entryName, snapshotPath, compileOutput || err.message, "compilation error", false);
            cleanup(filesToDelete);
            return passed; // Return true if error snapshot matches, false otherwise
        }

        // Run
        const runCmdStr = runCmd(langConfig.run);
        let runOutput;
        try {
            runOutput = execSync(runCmdStr, { cwd: EXAMPLES_DIR, encoding: 'utf8', stdio: 'pipe' });
        } catch (err) {
            const runErrorOutput = (err.stdout || "") + (err.stderr || "");
            const snapshotPath = getErrorSnapshotPath();
            ensureResultDir(isSuite ? path.join(entryName, 'test.err') : entryName + '.err');
            const passed = await verifySnapshot(entryName, snapshotPath, runErrorOutput || err.message, "execution error", false);
            cleanup(filesToDelete);
            return passed; // Return true if error snapshot matches, false otherwise
        }

        // Runtime Snapshot (Success Case)
        let runResultPath;
        if (isSuite) {
            runResultPath = path.join(RESULTS_DIR, entryName, 'test.run');
        } else {
             runResultPath = path.join(RESULTS_DIR, entryName + '.run');
        }
        ensureResultDir(isSuite ? path.join(entryName, 'test.run') : entryName + '.run');

        const runtimePassed = await verifySnapshot(entryName, runResultPath, runOutput, "runtime", true);
        if (!runtimePassed) {
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
            return path.basename(f);
        });
    } else {
        const all = fs.readdirSync(EXAMPLES_DIR);
        entries = all.filter(f => {
            if (f.startsWith('upp.')) return false;
            const p = path.join(EXAMPLES_DIR, f);
            const stat = fs.statSync(p);
            return f.endsWith('.c') || stat.isDirectory();
        });
    }

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
