import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { resolveConfig } from './config_loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXAMPLES_DIR = path.join(__dirname, 'examples');
const RESULTS_DIR = path.join(__dirname, 'test-results');
const UPDATE_FLAG = process.argv.includes('--update');

if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR);
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

async function runTest(file) {
    const filePath = path.join(EXAMPLES_DIR, file);
    let resultPath = path.join(RESULTS_DIR, file);
    const baseName = path.basename(file);
    const ext = path.extname(baseName).slice(1);
    const fileNameWithoutExt = path.parse(baseName).name;

    console.log(`Testing ${baseName}...`);

    let output;
    let success = false;
    try {
        const run = spawnSync('node', ['index.js', filePath], { encoding: 'utf8' });
        output = run.stdout + run.stderr;
        if (run.stderr?.length) {
            resultPath = resultPath.replace(/\.c$/, '.err');
        } else {
            success = true;
        }
    } catch (err) {
        console.error(`Error running ${baseName}:`, err.message);
        return false;
    }

    // Standard Snapshot Check
    if (!fs.existsSync(resultPath)) {
        console.log(`[NEW] Creating snapshot for ${baseName}`);
        fs.writeFileSync(resultPath, output);
        // If it was a new snapshot, we treat it as passing for now (user can update later)
        // But we should continue to compile/run if successful?
        // Let's assume yes if successful.
    } else {
        const existingOutput = fs.readFileSync(resultPath, 'utf8');
        if (output !== existingOutput) {
            console.log(`[FAIL] ${baseName} differs from snapshot!`);
            console.log(getDiff(resultPath, output));

            let shouldUpdate = UPDATE_FLAG;
            if (!shouldUpdate) {
                const answer = await ask(`Update snapshot for ${baseName}? (y/n): `);
                if (answer === 'y') shouldUpdate = true;
            }

            if (shouldUpdate) {
                fs.writeFileSync(resultPath, output);
                console.log(`[UPDATE] Updated snapshot for ${baseName}`);
            } else {
                console.log(`[FAIL] ${baseName} failed.`);
                return false;
            }
        } else {
            console.log(`[PASS] ${baseName}`);
        }
    }

    // Compilation and Execution Stage
    if (success) {
        const config = resolveConfig(filePath);
        const langConfig = (config.lang && config.lang[ext]) || {};

        if (langConfig.compile && langConfig.run) {
            const outputPath = path.join(path.dirname(filePath), `upp.${baseName}`);

            // Check if output file exists (it should if success)
            if (!fs.existsSync(outputPath)) {
                 // Maybe it was just stdout? The runner might need to save it for compilation
                 // index.js saves to defaults if configured?
                 // Actually index.js does not save to file by default unless post-upp is set.
                 // We might need to manually save processedSource if we want to compile it.
                 // Wait, index.js prints to stdout if no post-upp.
                 // So we need to save 'output' to a temp file for compilation if appropriate.

                 // HACK: index.js doesn't expose the output path easily if it's stdout.
                 // But upp.json defines compile command using ${OUTPUT}.
                 // If index.js wrote to stdout, we need to create a file.
                 fs.writeFileSync(outputPath, output);
            }

            const vars = {
                'INPUT': filePath,
                'BASENAME': fileNameWithoutExt,
                'FILENAME': baseName,
                'OUTPUT': outputPath,
                'OUTPUT_BASENAME': fileNameWithoutExt
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
                console.error(`[FAIL] Compilation failed for ${baseName}`);
                console.error(err.message);
                console.error(err.stderr.toString());
                return false;
            }

            // Run
            const runCmdStr = runCmd(langConfig.run);
            let runOutput;
            try {
                runOutput = execSync(runCmdStr, { cwd: EXAMPLES_DIR, encoding: 'utf8' });
            } catch (err) {
                console.error(`[FAIL] Execution failed for ${baseName}`);
                console.error(err.message);
                return false;
            }

            // Verify Run Output
            const runResultPath = resultPath + '.run';
            if (!fs.existsSync(runResultPath)) {
                console.log(`[NEW] Creating runtime snapshot for ${baseName}`);
                fs.writeFileSync(runResultPath, runOutput);
            } else {
                const existingRunOutput = fs.readFileSync(runResultPath, 'utf8');
                if (runOutput !== existingRunOutput) {
                    console.log(`[FAIL] ${baseName} runtime output differs!`);
                    console.log(getDiff(runResultPath, runOutput));

                     let shouldUpdate = UPDATE_FLAG;
                    if (!shouldUpdate) {
                        const answer = await ask(`Update runtime snapshot for ${baseName}? (y/n): `);
                        if (answer === 'y') shouldUpdate = true;
                    }

                    if (shouldUpdate) {
                        fs.writeFileSync(runResultPath, runOutput);
                        console.log(`[UPDATE] Updated runtime snapshot for ${baseName}`);
                    } else {
                        return false;
                    }
                } else {
                    console.log(`[PASS] ${baseName} (runtime)`);
                }
            }
        }
    }

    return true;
}

async function main() {
    const files = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.c') && !f.startsWith('upp.'));
    let allPassed = true;

    for (const file of files) {
        const passed = await runTest(file);
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
