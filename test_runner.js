const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

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

    console.log(`Testing ${baseName}...`);

    let output;
    try {
        const run = spawnSync('node', ['index.js', filePath], { encoding: 'utf8' });
        output = run.stdout + run.stderr;
        if (run.stderr?.length) {
            resultPath = resultPath.replace(/\.c$/, '.err');
        }
    } catch (err) {
        console.error(`Error running ${baseName}:`, err.message);
        return false;
    }

    if (!fs.existsSync(resultPath)) {
        console.log(`[NEW] Creating snapshot for ${baseName}`);
        fs.writeFileSync(resultPath, output);
        return true;
    }

    const existingOutput = fs.readFileSync(resultPath, 'utf8');
    if (output === existingOutput) {
        console.log(`[PASS] ${baseName}`);
        return true;
    }

    console.log(`[FAIL] ${baseName} differs from snapshot!`);
    console.log(getDiff(resultPath, output));

    if (UPDATE_FLAG) {
        console.log(`[UPDATE] Updating snapshot for ${baseName}`);
        fs.writeFileSync(resultPath, output);
        return true;
    }

    const answer = await ask(`Update snapshot for ${baseName}? (y/n): `);
    if (answer === 'y') {
        fs.writeFileSync(resultPath, output);
        console.log(`[UPDATE] Updated snapshot for ${baseName}`);
        return true;
    }

    console.log(`[FAIL] ${baseName} failed.`);
    return false;
}

async function main() {
    const files = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.c'));
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
