import path from 'path';

/**
 * @typedef {Object} CliOptions
 * @property {string[]} inputFiles - List of absolute paths to input files.
 * @property {string|null} outputFile - Absolute path to output file (if -o specified).
 * @property {string[]} includePaths - List of absolute include paths.
 * @property {boolean} writeMode - Whether -w/--write was specified.
 * @property {boolean} runMode - Whether --run was specified.
 * @property {boolean} isHelp - Whether --help was specified.
 */

/**
 * Parses command line arguments for the upp tool.
 * @param {string[]} args - Raw arguments from process.argv.slice(2).
 * @returns {CliOptions} The parsed command line options.
 */
export function parseArgs(args) {
    if (!args.length || args.includes('-?') || args.includes('--help')) {
        return {
            inputFiles: [],
            outputFile: null,
            includePaths: [],
            writeMode: false,
            runMode: false,
            isHelp: true
        };
    }

    const mutableArgs = [...args];
    let outputFile = null;
    const includePaths = [process.cwd()];
    let writeMode = false;
    let runMode = false;

    // Parse -o (Output File)
    const outputFileIdx = mutableArgs.indexOf('-o');
    if (outputFileIdx !== -1) {
        if (outputFileIdx + 1 < mutableArgs.length) {
            outputFile = mutableArgs[outputFileIdx + 1];
            mutableArgs.splice(outputFileIdx, 2);
        } else {
             // If -o is last without arg, maybe just ignore or error?
             // Current logic in index.js would take undefined.
             // Let's safe-guard.
             mutableArgs.splice(outputFileIdx, 1);
        }
    }

    // Parse -w / --write (Write Mode)
    const wIdx = mutableArgs.indexOf('-w');
    if (wIdx !== -1) {
        writeMode = true;
        mutableArgs.splice(wIdx, 1);
    }
    const writeIdx = mutableArgs.indexOf('--write');
    if (writeIdx !== -1) {
        writeMode = true;
        mutableArgs.splice(writeIdx, 1);
    }

    // Parse --run / -r (Run Mode)
    const runIdx = mutableArgs.indexOf('--run');
    const rIdx = mutableArgs.indexOf('-r');
    if (runIdx !== -1 || rIdx !== -1) {
        runMode = true;
        if (runIdx !== -1) mutableArgs.splice(runIdx, 1);
        else mutableArgs.splice(rIdx, 1);
    }

    // Parse -I (Include Paths)
    let includeIdx;
    while ((includeIdx = mutableArgs.indexOf('-I')) !== -1) {
        if (includeIdx + 1 < mutableArgs.length) {
            includePaths.push(path.resolve(mutableArgs[includeIdx + 1]));
            mutableArgs.splice(includeIdx, 2);
        } else {
            mutableArgs.splice(includeIdx, 1);
        }
    }

    // What remains are input files
    // Validate: Cannot specify -o with multiple input files
    if (mutableArgs.length > 1 && outputFile) {
        console.error("Error: Cannot specify -o with multiple input files.");
        process.exit(1);
    }

    // Absolute paths for inputs? index.js does path.resolve() in the loop.
    // Let's leave them as passed strings, but JSDoc says "absolute paths".
    // index.js loop does: const absolutePath = path.resolve(filePath);
    // Let's resolve them here for consistency with JSDoc.
    // Wait, index.js loop iterates over args.

    // Actually, `index.js` logic was:
    // for (const filePath of args) { const absolutePath = path.resolve(filePath); ... }
    // So distinct handling. Let's return the strings passed by user (relative or absolute)
    // BUT the JSDoc says absolute. Let's make them absolute here.
    const inputFiles = mutableArgs.map(f => path.resolve(f));

    return {
        inputFiles,
        outputFile,
        includePaths,
        writeMode,
        runMode,
        isHelp: false
    };
}
