import path from 'path';
import fs from 'fs';

/**
 * @typedef {Object} CompilerCommand
 * @property {string[]} fullCommand - The full compiler command args.
 * @property {string} compiler - The compiler executable (e.g. 'gcc').
 * @property {Array<{cFile: string, cupFile: string}>} sources - Pairs of .c and .cup files found.
 * @property {boolean} isUppCommand - Whether this is a valid upp wrapper invocation.
 */

/**
 * Parses command line arguments for the upp compiler wrapper.
 * Expects args to be [compiler, ...compiler_args]
 * @param {string[]} args - Raw arguments from process.argv.slice(2).
 * @returns {CompilerCommand} The parsed command info.
 */
export function parseArgs(args) {
    if (!args.length) {
        return { isUppCommand: false, fullCommand: [], compiler: '', sources: [], includePaths: [] };
    }

    const compiler = args[0];
    const sources = [];
    const includePaths = [];
    const depFlags = [];
    let depOutputFile = null;

    // Simple heuristic: Find arguments ending in .c
    // Robust parsing of GCC flags is hard, but .c files are usually distinct.
    // We assume any argument ending in .c that exists (or is intended to exist) is a source.

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        // Source detection
        if (arg.endsWith('.c')) {
            const absC = path.resolve(arg);
            const absCup = absC + 'up'; // .c -> .cup
            sources.push({
                cFile: arg,
                absCFile: absC,
                cupFile: arg + 'up',
                absCupFile: absCup
            });
        }

        // Include paths
        if (arg.startsWith('-I')) {
             if (arg.length > 2) {
                 includePaths.push(path.resolve(arg.slice(2)));
             } else if (i + 1 < args.length) {
                 includePaths.push(path.resolve(args[i+1]));
                 // We don't advance i here to avoid messing up other checks,
                 // but strictly we should.
                 // Given the simple loop, we just re-process next arg as start of -I? No.
                 // Ideally we skip. But 'sources' check is specific.
             }
        }

        // Dependency Flags
        if (arg === '-MD' || arg === '-MMD') {
            depFlags.push(arg);
        } else if (arg === '-MF' || arg === '-MT' || arg === '-MQ') {
            depFlags.push(arg);
             if (i + 1 < args.length) {
                 const val = args[i+1];
                 depFlags.push(val);
                 if (arg === '-MF') depOutputFile = val;
             }
        }
    }

    return {
        isUppCommand: true,
        fullCommand: args,
        compiler,
        sources,
        includePaths,
        depFlags,
        depOutputFile
    };
}

