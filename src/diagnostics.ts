/**
 * Enum for Diagnostic Codes.
 * @readonly
 * @enum {string}
 */
export const DiagnosticCodes = {
    MACRO_REDEFINITION: 'UPP001',
    MISSING_INCLUDE: 'UPP002',
    SYNTAX_ERROR: 'UPP003'
} as const;

export interface DiagnosticsConfig {
    suppress?: string[];
}

/**
 * Manages reporting of warnings and errors with suppression support.
 * @class
 */
export class DiagnosticsManager {
    private suppressed: Set<string | number>;

    /**
     * @param {DiagnosticsConfig} [config={}] - Configuration object with suppression list.
     */
    constructor(config: DiagnosticsConfig = {}) {
        /** @type {Set<string | number>} */
        this.suppressed = new Set(config.suppress || []);
    }

    /**
     * Reports a warning if not suppressed.
     * @param {string | number} code - The diagnostic code (e.g., UPP001).
     * @param {string} message - The warning message.
     * @param {string} filePath - File where warning occurred.
     * @param {number} [line=0] - Line number (1-indexed).
     * @param {number} [col=0] - Column number (1-indexed).
     * @param {string | null} [sourceCode=null] - Optional source code for context.
     */
    reportWarning(code: string | number, message: string, filePath: string, line: number = 0, col: number = 0, sourceCode: string | null = null): void {
        if (this.suppressed.has(code)) return;

        const loc = line > 0 ? `:${line}:${col}` : '';
        console.warn(`\x1b[33m${filePath}${loc}: warning: [${code}] ${message}\x1b[0m`);

        if (sourceCode && line > 0) {
            // Re-split source to find line content.
            // This is efficient enough for warnings which shouldn't be spammy.
            const lines = sourceCode.split('\n');
            const lineContent = lines[line - 1];
            if (lineContent !== undefined) {
                console.warn(lineContent);
                console.warn(' '.repeat(Math.max(0, col - 1)) + '\x1b[33m^\x1b[0m');
            }
        }
    }

    /**
     * Reports an error and optionally exits.
     * @param {string | number} code - The diagnostic code.
     * @param {string} message - The error message.
     * @param {string} filePath - File where error occurred.
     * @param {number} [line=0] - Line number (1-indexed).
     * @param {number} [col=0] - Column number (1-indexed).
     * @param {string | null} [sourceCode=null] - Optional source code.
     * @param {boolean} [fatal=true] - Whether to exit the process.
     */
    reportError(code: string | number, message: string, filePath: string, line: number = 0, col: number = 0, sourceCode: string | null = null, fatal: boolean = true): void {
        const loc = line > 0 ? `:${line}:${col}` : '';
        console.error(`\x1b[31m${filePath}${loc}: error: [${code}] ${message}\x1b[0m`);

        if (sourceCode && line > 0) {
            const lines = sourceCode.split('\n');
            const lineContent = lines[line - 1];
            if (lineContent !== undefined) {
                console.error(lineContent);
                console.error(' '.repeat(Math.max(0, col - 1)) + '\x1b[31m^\x1b[0m');
            }
        }

        if (fatal) process.exit(1);
    }

    /**
     * Helper to calculate line and column from character index.
     * @param {string} source - Source code.
     * @param {number} index - Character index.
     * @returns {{line: number, col: number}} 1-indexed line and col.
     */
    static getLineCol(source: string, index: number): { line: number; col: number } {
        let line = 1;
        let col = 1;
        for (let i = 0; i < index && i < source.length; i++) {
            if (source[i] === '\n') {
                line++;
                col = 1;
            } else {
                col++;
            }
        }
        return { line, col };
    }
}
