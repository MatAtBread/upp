/**
 * Reports an error with formatted source context.
 * @param {import('tree-sitter').SyntaxNode} node - The AST node where the error occurred.
 * @param {string} sourceCode - The full source code content.
 * @param {string} message - The error message to display.
 * @param {string} [filePath='input'] - The file path for the error header.
 */
function reportError(node, sourceCode, message, filePath = 'input') {
    const { startPosition } = node;
    const lines = sourceCode.split('\n');
    const lineIndex = startPosition.row;
    const lineContent = lines[lineIndex];

    const errorPrefix = `${filePath}:${lineIndex + 1}:${startPosition.column + 1}: error: `;
    console.error(`\x1b[1m${errorPrefix}${message}\x1b[0m`);
    console.error(lineContent);
    console.error(' '.repeat(startPosition.column) + '\x1b[1;31m^\x1b[0m');
}

module.exports = { reportError };
