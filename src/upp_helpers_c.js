import { UppHelpersBase } from './upp_helpers_base.js';
import Parser from 'tree-sitter';
import { PatternMatcher } from './pattern_matcher.js';

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
class UppHelpersC extends UppHelpersBase {
     /**
     * @param {import('./registry.js').Registry} registry - The registry instance.
     */
    constructor(registry) {
        super(registry);
        this.matcher = null; // Unused, but kept for compatibility if accessed directly? No, remove.
    }

    // Shared matcher instance
    static matcherInstance = null;

    /**
     * Matches a pattern against code.
     * Supports two signatures:
     * 1. match(options, callback) - Legacy
     * 2. match(node, srcOrOptions, callback) - New
     * @param {import('tree-sitter').SyntaxNode} node - Target node.
     * @param {string} src - Pattern source code.
     * @param {function(Object): any} callback - Callback with captures.
     * @param {Object} [options] - Match options.
     * @param {boolean} [options.deep=false] - Whether to search deep.
     * @returns {any} Result of callback or captures object (or null).
     */
    match(node, src, callback, options = {}) {
        if (!node) throw new Error("upp.match: Argument 1 must be a valid node.");
        if (typeof src !== 'string') throw new Error("upp.match: Argument 2 (src) must be a string.");

        if (!UppHelpersC.matcherInstance) {
             // Pass a parser function bound to registry
             // We need to parse strict fragment
             const parser = new Parser();
             parser.setLanguage(this.registry.language);

             UppHelpersC.matcherInstance = new PatternMatcher((src) => {
                 return parser.parse(src);
             });
        }

        const deep = options.deep === true;
        const result = UppHelpersC.matcherInstance.match(node, src, deep);

        if (result) {
            if (callback) {
                return callback(result);
            }
            return result;
        }
        return null;
    }

     /**
      * Matches a pattern against code and performs replacement.
      * @param {import('tree-sitter').SyntaxNode} node - Target node (root search starts here).
      * @param {string} src - Pattern source code.
      * @param {function(Object): string} callback - Callback returning replacement string.
      * @param {Object} [options] - Match options.
      * @param {boolean} [options.deep=false] - Whether to search deep.
      */
    matchReplace(node, src, callback, options = {}) {
        this.match(node, src, (captures) => {
            if (captures && captures.node) {
                 const replacement = callback(captures);
                 if (replacement !== null && replacement !== undefined) {
                     this.replace(captures.node, replacement);
                 }
            }
        }, options);
    }
    /**
     * Hoists content to the top of the file, skipping comments.
     * @param {string} content - The content to hoist.
     * @param {number} [hoistIndex=0] - The index to hoist to.
     */
    hoist(content, hoistIndex = 0) {
        const root = this.registry.mainTree.rootNode;
        for (let i = 0; i < root.childCount; i++) {
            const child = root.child(i);
            if (child.type === 'comment') {
                 // skip
            } else {
                 if (child.startIndex > hoistIndex) break;
            }
        }

        // Ensure we prepend a newline if needed
        this.replace({start: hoistIndex, end: hoistIndex}, "\n" + content);
    }

    /**
     * extracts the C type string from a definition node.
     * @param {import('tree-sitter').SyntaxNode} defNode - The definition identifier node.
     * @returns {string} The C type string (e.g. "char *").
     */
    getType(defNode) {
        if (!defNode) return "void *";

        // Walk up to find declaration
        let declNode = defNode;
        while (declNode &&
               declNode.type !== 'declaration' &&
               declNode.type !== 'parameter_declaration' &&
               declNode.type !== 'field_declaration' &&
               declNode.type !== 'type_definition') {
            declNode = this.parent(declNode);
        }

        if (!declNode) {
            // Heuristic: Check previous sibling?
            const prev = this.registry.helpers.nextNamedSibling ? null : null; // Access generic?
            // upp_helpers_base has previousNamedSibling? No.
            // But we can check if defNode has a type sibling?
            // Usually in C: 'Type name;' -> 'name' is declarator. 'Type' is specifier.
            // In tree-sitter C, structure varies.
            return "void *"; // fallback
        }

        let suffix = "";
        // Check for pointer declarators in children
        // Safe linear scan of children or query scoped to declNode
        const ptrs = this.query('(pointer_declarator) @ptr', declNode);
        for (const p of ptrs) {
            // Validate it wraps our identifier?
            // Simplified heuristic: count pointers in the declaration
            if (this.isDescendant(declNode, p.captures.ptr)) {
                 suffix += "*";
            }
        }

        const typeNode = this.childForFieldName(declNode, 'type'); // type is usually a direct field, let's hope it's safe
        const baseType = typeNode ? typeNode.text : "void";

        return baseType + " " + suffix;
    }

    /**
     * Extracts function signature details.
     * @param {import('tree-sitter').SyntaxNode} fnNode - The function_definition node.
     * @returns {{returnType: string, name: string, params: string}} Signature details.
     */
    getFunctionSignature(fnNode) {
        const declarator = this.childForFieldName(fnNode, 'declarator');
        let funcDecl = declarator;
        while (funcDecl && funcDecl.type === 'pointer_declarator') {
            funcDecl = this.childForFieldName(funcDecl, 'declarator');
        }

        const nameNode = funcDecl ? this.childForFieldName(funcDecl, 'declarator') : null;
        const name = nameNode ? nameNode.text : "unknown";

        const paramList = funcDecl ? this.childForFieldName(funcDecl, 'parameters') : null;
        let params = "";
        if (paramList) {
             params = paramList.text;
        }

        const typeNode = this.childForFieldName(fnNode, 'type');
        const returnType = typeNode ? typeNode.text : "void";

        return { returnType, name, params };
    }

    /**
     * Finds the definition for a node.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition.
     */
    getDefinition(node) {
        return this.registry.getDefinition(node);
    }

    /**
     * Finds references to a definition.
     * @param {import('tree-sitter').SyntaxNode} node - The definition node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} The references.
     */
    findReferences(node) {
        return this.registry.findReferences(node);
    }
}

export { UppHelpersC };
