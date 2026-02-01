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

// Step 1: Run UPP transformation and verify snapshot
async function runUppTransformation(relativePath) {
    const filePath = path.join(EXAMPLES_DIR, relativePath);
    ensureResultDir(relativePath);
    let resultPath = path.join(RESULTS_DIR, relativePath);
    const baseName = path.basename(relativePath);

    let output;
    let isError = false;
    try {
        const run = spawnSync('node', ['index.js', filePath], { encoding: 'utf8' });
        output = run.stdout + run.stderr;

        // 1. Check for existing .err snapshot (explicit override)
        const errSnapshotPath = path.join(RESULTS_DIR, relativePath + '.err');
        if (fs.existsSync(errSnapshotPath)) {
            resultPath = errSnapshotPath;
            isError = true;
        }
        // 2. Check for runtime indicators of error
        // Note: checking stdout emptiness is fragile if Upp prints errors to stdout.
        // Checking exit code is better.
        else if (run.status !== 0 || (run.stderr?.length && !run.stdout?.trim().length)) {
             resultPath = resultPath + '.err';
             isError = true;
        }
    } catch (err) {
        console.error(`Error running ${baseName}:`, err.message);
        return { pass: false, compilationReady: false, outputPath: null };
    }

    // Standard Snapshot Check
    if (!fs.existsSync(resultPath)) {
        console.log(`[NEW] Creating snapshot for ${relativePath}`);
        fs.writeFileSync(resultPath, output);
    } else {
        const existingOutput = fs.readFileSync(resultPath, 'utf8');
        if (output !== existingOutput) {
            console.log(`[FAIL] ${relativePath} differs from snapshot!`);
            console.log(getDiff(resultPath, output));

            let shouldUpdate = UPDATE_FLAG;
            if (!shouldUpdate && process.stdin.isTTY) {
                const answer = await ask(`Update snapshot for ${relativePath}? (y/n): `);
                if (answer === 'y') shouldUpdate = true;
            }

            if (shouldUpdate) {
                fs.writeFileSync(resultPath, output);
                console.log(`[UPDATE] Updated snapshot for ${relativePath}`);
            } else {
                console.log(`[FAIL] ${relativePath} failed.`);
                return { pass: false, compilationReady: false, outputPath: null };
            }
        } else {
             console.log(`[PASS] ${relativePath}`);
        }
    }

    // Write output for compilation
    const outputPath = path.join(path.dirname(filePath), `upp.${path.basename(filePath)}`);
    fs.writeFileSync(outputPath, output);
    return { pass: true, compilationReady: !isError, outputPath };
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

        // Compile
        const compileCmd = runCmd(langConfig.compile);
        try {
            execSync(compileCmd, { cwd: EXAMPLES_DIR, stdio: 'pipe' });
        } catch (err) {
            console.error(`[FAIL] Compilation failed for ${entryName}`);
             if (err.stderr) console.error(err.stderr.toString());
             else console.error(err.message);
            cleanup(filesToDelete);
            return false;
        }

        // Run
        const runCmdStr = runCmd(langConfig.run);
        let runOutput;
        try {
            runOutput = execSync(runCmdStr, { cwd: EXAMPLES_DIR, encoding: 'utf8' });
        } catch (err) {
            console.error(`[FAIL] Execution failed for ${entryName}`);
            console.error(err.message);
            cleanup(filesToDelete);
            return false;
        }

        // Runtime Snapshot
        let runResultPath;
        if (isSuite) {
            ensureResultDir(path.join(entryName, 'test.run'));
            runResultPath = path.join(RESULTS_DIR, entryName, 'test.run');
        } else {
             runResultPath = path.join(RESULTS_DIR, entryName + '.run');
        }

        if (!fs.existsSync(runResultPath)) {
            console.log(`[NEW] Creating runtime snapshot for ${entryName}`);
            fs.writeFileSync(runResultPath, runOutput);
        } else {
            const existingRunOutput = fs.readFileSync(runResultPath, 'utf8');
            if (runOutput !== existingRunOutput) {
                console.log(`[FAIL] ${entryName} runtime output differs!`);
                console.log(getDiff(runResultPath, runOutput));

                let shouldUpdate = UPDATE_FLAG;
                if (!shouldUpdate && process.stdin.isTTY) {
                    const answer = await ask(`Update runtime snapshot for ${entryName}? (y/n): `);
                    if (answer === 'y') shouldUpdate = true;
                }

                if (shouldUpdate) {
                    fs.writeFileSync(runResultPath, runOutput);
                    console.log(`[UPDATE] Updated runtime snapshot for ${entryName}`);
                } else {
                    cleanup(filesToDelete);
                    return false;
                }
            } else {
                console.log(`[PASS] ${entryName} (runtime)`);
            }
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
