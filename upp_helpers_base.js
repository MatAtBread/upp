import Parser from 'tree-sitter';
const { Query } = Parser;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    /**
     * @param {import('./registry').Registry} registry - The registry instance.
     */
    constructor(registry) {
        /** @type {import('./registry').Registry} */
        this.registry = registry;
        /** @type {Array<Object>} */
        this.replacements = [];
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.root = null;
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.contextNode = null;
        /** @type {Object|null} */
        this.invocation = null; // Current macro invocation details
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.lastConsumedNode = null;
    }

    /**
     * Debugs a node by printing its type and text.
     * @param {import('tree-sitter').SyntaxNode} node - The tree-sitter node to debug.
     */
    debug(node) {
        console.log(`Debug Node: type=${node.type}, text="${node.text.slice(0, 50)}${node.text.length > 50 ? '...' : ''}"`);
    }

    /**
     * Creates a unique identifier with the given prefix.
     * @param {string} [prefix='v'] - The prefix for the identifier.
     * @returns {string} A unique identifier.
     */
    createUniqueIdentifier(prefix = 'v') {
        const id = this.registry.idCounter++;
        return `${prefix}_${id}`;
    }

    /**
     * Tagged template literal for generating code and parse trees.
     * @param {TemplateStringsArray} strings - Template strings.
     * @param {...any} values - Interpolated values.
     * @returns {{text: string, tree: function(): import('tree-sitter').Tree}} An object containing the generated text and a lazy tree parser.
     */
    code(strings, ...values) {
        const result = strings.reduce((acc, str, i) => {
            let value = values[i] !== undefined ? values[i] : '';
            if (value && typeof value === 'object' && value.text !== undefined) {
                value = value.text;
            }
            return acc + str + value;
        }, '');

        return {
            text: result,
            tree: () => {
                const parser = new Parser();
                parser.setLanguage(this.registry.language);
                return parser.parse(result);
            }
        };
    }

    /**
     * Replaces a node with new content.
     * @param {import('tree-sitter').SyntaxNode|{start: number, end: number}} n - The node or range to replace.
     * @param {string|{text: string}} newContent - The new content string or object with text property.
     */
    replace(n, newContent) {
        const start = n.startIndex !== undefined ? n.startIndex : n.start;
        const end = n.endIndex !== undefined ? n.endIndex : n.end;

        let isGlobal = false;
        if (n.tree) {
            isGlobal = this.registry.mainTree && (n.tree === this.registry.mainTree);
        } else {
            isGlobal = (this === this.registry.helpers);
        }

        if (isGlobal && this.registry.isInsideInvocation(start, end)) {
            if (!(this.invocation && this.invocation.startIndex === start && this.invocation.endIndex === end)) {
                return;
            }
        }

        const replacement = {
            start: start,
            end: end,
            content: typeof newContent === 'object' ? newContent.text : String(newContent),
            isLocal: !isGlobal,
            node: n
        };

        if (isGlobal && this.registry.helpers !== this) {
            this.registry.helpers.replacements.push(replacement);
        } else {
            this.replacements.push(replacement);
        }
    }

    /**
     * Wraps a node (placeholder for future extensibility).
     * @param {import('tree-sitter').SyntaxNode} node - The node to wrap.
     * @returns {import('tree-sitter').SyntaxNode} The wrapped node.
     */
    wrapNode(node) {
        return node;
    }

    /**
     * Registers a global transformation function.
     * @param {function(import('tree-sitter').Tree, UppHelpersBase): void} transformFn - The transformation function.
     */
    registerTransform(transformFn) {
        this.registry.registerTransform(transformFn);
    }

    /**
     * Recursively walks the tree calling the callback for each node.
     * @param {import('tree-sitter').SyntaxNode} node - The starting node.
     * @param {function(import('tree-sitter').SyntaxNode): void} callback - The callback function.
     */
    walk(node, callback) {
        if (!node) return;
        callback(node);
        const count = node.childCount;
        for (let i = 0; i < count; i++) {
            try {
                this.walk(node.child(i), callback);
            } catch (e) {
                // Ignore traversal errors for bad nodes (e.g. NodeClass constructor issues)
            }
        }
    }

    /**
     * Finds the nearest enclosing node of a specific type.
     * @param {import('tree-sitter').SyntaxNode} node - The starting node.
     * @param {string} type - The node type to search for.
     * @returns {import('tree-sitter').SyntaxNode|null} The enclosing node or null.
     */
    findEnclosing(node, type) {
        let current = node.parent;
        while (current) {
            if (current.type === type) return current;
            current = current.parent;
        }
        return null;
    }

    /**
     * Returns all subsequent named siblings of a node.
     * @param {import('tree-sitter').SyntaxNode} node - The reference node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} List of sibling nodes.
     */
    nextSiblings(node) {
        const siblings = [];
        let current = node.nextNamedSibling;
        while (current) {
            siblings.push(current);
            current = current.nextNamedSibling;
        }
        return siblings;
    }

    /**
     * Executes a tree-sitter query.
     * @param {string} pattern - The S-expression query pattern.
     * @param {import('tree-sitter').SyntaxNode} [node] - The scope node for the query.
     * @returns {Array<{pattern: number, captures: Object<string, import('tree-sitter').SyntaxNode>}>} Query matches with named captures.
     */
    query(pattern, node) {
        const query = new Query(this.registry.language, pattern);
        let targetNode = node || this.root;
        if (targetNode && targetNode.rootNode) {
            targetNode = targetNode.rootNode;
        }
        if (!targetNode) {
            console.error("UppHelpersBase.query: targetNode is null/undefined");
            return [];
        }
        if (!targetNode.tree) {
             // Try to handle Tree object passed as SyntaxNode? No, caught above.
             // If SyntaxNode is detached?
             console.error(`UppHelpersBase.query: targetNode.tree is undefined. Type: ${targetNode.type}, Constructor: ${targetNode.constructor.name}`);
        }
        const matches = query.matches(targetNode);

        return matches.map(m => {
            const captures = {};
            for (const c of m.captures) {
                captures[c.name] = c.node;
            }
            return {
                pattern: m.pattern,
                captures: captures
            };
        });
    }

    /**
     * Consumes the next available node, optionally validating its type.
     * Automatically marks the consumed node for deletion.
     * @param {string|string[]|{type: string|string[], message: string, validate: function(import('tree-sitter').SyntaxNode): boolean}} [expectedTypeOrOptions] - Expected type(s) or validation options.
     * @param {string} [errorMessage] - Custom error message if validation fails.
     * @returns {import('tree-sitter').SyntaxNode|null} The consumed node.
     */
    consume(expectedTypeOrOptions, errorMessage) {
        let expectedTypes = null;
        let internalErrorMessage = errorMessage;
        let validateFn = null;

        if (typeof expectedTypeOrOptions === 'string') {
            expectedTypes = [expectedTypeOrOptions];
        } else if (Array.isArray(expectedTypeOrOptions)) {
            expectedTypes = expectedTypeOrOptions;
        } else if (expectedTypeOrOptions && typeof expectedTypeOrOptions === 'object') {
            expectedTypes = Array.isArray(expectedTypeOrOptions.type) ? expectedTypeOrOptions.type : (expectedTypeOrOptions.type ? [expectedTypeOrOptions.type] : null);
            internalErrorMessage = expectedTypeOrOptions.message || errorMessage;
            validateFn = expectedTypeOrOptions.validate;
        }

        const reportFailure = (foundNode) => {
            const macroName = this.invocation ? `@${this.invocation.name}` : "macro";
            let msg = internalErrorMessage;

            if (!msg) {
                const expectedStr = expectedTypes ? expectedTypes.join(' or ') : 'an additional code block';
                const foundStr = foundNode ? `found ${foundNode.type}` : 'nothing found';
                msg = `${macroName} expected ${expectedStr}, but ${foundStr}`;
            }

            this.error(foundNode || (this.invocation && this.invocation.invocationNode) || this.contextNode, msg);
        };

        let node = null;
        if (!this.lastConsumedNode) {
            if (this.invocation && !this.invocation.hasNodeParam) {
                node = this.contextNode;
            }
        }

        if (!node) {
            let anchor = this.lastConsumedNode || this.contextNode;
            if (anchor) {
                node = anchor.nextNamedSibling;
                while (node && node.type.includes('comment')) {
                    node = node.nextNamedSibling;
                }
            }
        }

        if (!node) {
            if (expectedTypes || validateFn) reportFailure(null);
            return null;
        }

        if (node && expectedTypes && !expectedTypes.includes(node.type)) {
            let current = node;
            while (current && current.namedChildCount > 0 && !expectedTypes.includes(current.type)) {
                let firstChild = current.namedChild(0);
                if (firstChild && firstChild.startIndex === current.startIndex) {
                    current = firstChild;
                    if (expectedTypes.includes(current.type)) {
                        node = current;
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        if (expectedTypes && !expectedTypes.includes(node.type)) {
            reportFailure(node);
        }

        if (validateFn && !validateFn(node)) {
            reportFailure(node);
        }

        this.replace(node, "");
        this.lastConsumedNode = node;
        return node;
    }

    /**
     * Checks if a node is a descendant of a parent.
     * @param {import('tree-sitter').SyntaxNode} parent - The parent node.
     * @param {import('tree-sitter').SyntaxNode} node - The potential descendant.
     * @returns {boolean} True if node is a descendant.
     */
    isDescendant(parent, node) {
        let current = node;
        while (current) {
            if (current === parent || current.id === parent.id) return true;
            current = current.parent;
        }
        return false;
    }

    /**
     * Throws a UPP-specific error associated with a node.
     * @param {import('tree-sitter').SyntaxNode} node - The node where the error occurred.
     * @param {string} message - The error message.
     * @throws {Error} The associated error.
     */
    error(node, message) {
        const err = new Error(message);
        err.isUppError = true;
        err.node = node;
        throw err;
    }
}

export { UppHelpersBase };
