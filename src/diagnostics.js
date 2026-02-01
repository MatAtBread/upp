/**
 * Enum for Diagnostic Codes.
 * @readonly
 * @enum {string}
 */
export const DiagnosticCodes = {
    MACRO_REDEFINITION: 'UPP001',
    MISSING_INCLUDE: 'UPP002'
};

/**
 * Manages reporting of warnings and errors with suppression support.
 * @class
 */
export class DiagnosticsManager {
    /**
     * @param {Object} [config={}] - Configuration object with suppression list.
     */
    constructor(config = {}) {
        /** @type {Set<string>} */
        this.suppressed = new Set(config.suppress || []);
    }

    /**
     * Reports a warning if not suppressed.
     * @param {string} code - The diagnostic code (e.g., UPP001).
     * @param {string} message - The warning message.
     * @param {string} filePath - File where warning occurred.
     * @param {number} [line=0] - Line number (1-indexed).
     * @param {number} [col=0] - Column number (1-indexed).
     * @param {string} [sourceCode=null] - Optional source code for context.
     */
    reportWarning(code, message, filePath, line = 0, col = 0, sourceCode = null) {
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
     * Helper to calculate line and column from character index.
     * @param {string} source - Source code.
     * @param {number} index - Character index.
     * @returns {{line: number, col: number}} 1-indexed line and col.
     */
    static getLineCol(source, index) {
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
