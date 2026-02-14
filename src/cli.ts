import path from 'path';

export interface SourceInfo {
    cFile: string;
    absCFile: string;
    cupFile: string;
    absCupFile: string;
}

export interface CompilerCommand {
    isUppCommand: boolean;
    fullCommand?: string[];
    compiler?: string;
    sources?: SourceInfo[];
    includePaths?: string[];
    depFlags?: string[];
    depOutputFile?: string | null;
    mode?: string;
    file?: string;
    files?: string[];
}

/**
 * Parses command line arguments for the upp compiler wrapper.
 * Expects args to be [compiler, ...compiler_args]
 * @param {string[]} args - Raw arguments from process.argv.slice(2).
 * @returns {CompilerCommand} The parsed command info.
 */
export function parseArgs(args: string[]): CompilerCommand {
    if (args.length === 0) {
        return { isUppCommand: false };
    }

    if (args[0] === '--transpile' || args[0] === '--translate' || args[0] === '-T' || args[0] === '--ast' || args[0] === '--test' || args[0] === '-t') {
        const fileArgs = args.slice(1).filter(a => !a.startsWith('-'));
        if (fileArgs.length === 0) {
            console.error(`Error: ${args[0]} requires at least one file or directory argument.`);
            process.exit(1);
        }
        let mode = 'transpile';
        if (args[0] === '--ast') mode = 'ast';
        else if (args[0] === '--test' || args[0] === '-t') mode = 'test';

        // Support multiple files/directories
        const files = fileArgs.map(f => path.resolve(f));

        return {
            mode,
            file: files[0], // Keep for backward compatibility if needed
            files,
            isUppCommand: true,
            fullCommand: args,
            compiler: 'cc',
            sources: [],
            includePaths: [],
            depFlags: []
        };
    }

    const compiler = args[0];
    const sources: SourceInfo[] = [];
    const includePaths: string[] = [];
    const depFlags: string[] = [];
    let depOutputFile: string | null = null;

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
                includePaths.push(path.resolve(args[i + 1]));
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
                const val = args[i + 1];
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
