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
        this.matcher = new PatternMatcher((src) => this.registry._parse(src), this.registry.language);
    }

    /**
     * Matches a pattern against code.
     * @param {import('tree-sitter').SyntaxNode} node - Target node.
     * @param {string} src - Pattern source code.
     * @param {function(Object): any} callback - Callback with captures.
     * @param {Object} [options] - Match options.
     * @returns {any} Result of callback or captures object (or null).
     */
    match(node, src, callback, options = {}) {
        if (!node) throw new Error("upp.match: Argument 1 must be a valid node.");
        if (typeof src !== 'string') throw new Error("upp.match: Argument 2 (src) must be a string.");

        const deep = options.deep === true;
        const result = this.matcher.match(node, src, deep);

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
                 // Automatic recursion avoidance
                 // Key by transform AND pattern to allow different rules to touch the same node
                 const key = this.transformKey + "::" + src;

                 if (this.transformKey) {
                     if (this.registry.isVisited(key, captures.node)) return;
                     this.registry.visit(key, captures.node);
                 }

                 const replacement = callback(captures);
                 if (replacement !== null && replacement !== undefined) {
                     this.replace(captures.node, replacement);
                 }
            }
        }, options);
    }

    /**
     * Matches all occurrences of a pattern.
     * @param {import('tree-sitter').SyntaxNode} node - Target node.
     * @param {string} src - Pattern source code.
     * @param {function(Object): any} [callback] - Optional callback.
     * @param {Object} [options] - Options.
     * @returns {Array<Object>} Matches.
     */
    matchAll(node, src, callback, options = {}) {
        if (!node) throw new Error("upp.matchAll: Argument 1 must be a valid node.");
        if (typeof src !== 'string') throw new Error("upp.matchAll: Argument 2 (src) must be a string.");

        const deep = options.deep === true || (options.deep !== false && node.type === 'translation_unit');
        const matches = this.matcher.matchAll(node, src, deep);

        if (callback) {
            return matches.map(m => callback(m));
        }
        return matches;
    }

    /**
     * Replaces all matches of a pattern.
     * @param {import('tree-sitter').SyntaxNode} node - Scope.
     * @param {string} src - Pattern.
     * @param {function(Object): string} callback - Replacement callback.
     * @param {Object} [options] - Options.
     */
    matchReplaceAll(node, src, callback, options = {}) {
        this.matchAll(node, src, (captures) => {
            if (captures && captures.node) {
                 // Automatic recursion avoidance
                 const key = this.transformKey + "::" + src;

                 if (this.transformKey) {
                     if (this.registry.isVisited(key, captures.node)) return;
                     this.registry.visit(key, captures.node);
                 }

                 const replacement = callback(captures);
                 if (replacement !== null && replacement !== undefined) {
                     this.replace(captures.node, replacement);
                 }
            }
        }, { ...options, deep: true }); // Default to deep for matchReplaceAll
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

    /**
     * Mark a node as visited.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {boolean} True if new visit.
     */
    visit(node) {
        return this.registry.visit(this.transformKey, node);
    }

    /**
     * Check if visited.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {boolean} True if visited.
     */
    isVisited(node) {
        return this.registry.isVisited(this.transformKey, node);
    }
}

export { UppHelpersC };
