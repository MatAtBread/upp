import { UppHelpersBase } from './upp_helpers_base.js';
import { RECURSION_LIMITER_ENABLED } from './registry.js';
import { PatternMatcher } from './pattern_matcher.js';
import { SourceNode } from './source_tree.js';
import Parser from 'tree-sitter';

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
class UppHelpersC extends UppHelpersBase {
    constructor(root, registry, parentHelpers = null) {
        super(root, registry, parentHelpers);
        // Use a dedicated parser for patterns to avoid invalidating the main registry parser/tree
        const patternParser = new Parser();
        patternParser.setLanguage(registry.language);
        this.matcher = new PatternMatcher((src) => patternParser.parse(src), registry.language);
    }

    /**
     * Matches a pattern against code.
     * @param {SourceNode} node - Target node.
     * @param {string} src - Pattern source code.
     * @param {function(Object): any} callback - Callback with captures.
     * @param {Object} [options] - Match options.
     * @returns {any} Result of callback or captures object (or null).
     */
    match(node, src, callback, options = {}) {
        if (!node) throw new Error("upp.match: Argument 1 must be a valid node.");

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true;

        for (const s of srcs) {
            const result = this.matcher.match(node, s, deep);
            if (result) {
                if (callback) return callback(result);
                return result;
            }
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
                    if (!this.registry.visit(key, captures.node)) return;
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

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true || (options.deep !== false && node.type === 'translation_unit');

        const allMatches = [];
        const seenIds = new Set();

        for (const s of srcs) {
            const matches = this.matcher.matchAll(node, s, deep);
            for (const m of matches) {
                if (!seenIds.has(m.node.id)) {
                    allMatches.push(m);
                    seenIds.add(m.node.id);
                }
            }
        }

        if (callback) {
            return allMatches.map(m => callback(m));
        }
        return allMatches;
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
                    if (RECURSION_LIMITER_ENABLED && !this.registry.visit(key, captures.node)) return;
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
        const root = this.root; // Stable root
        if (root.children.length > 0) {
            root.children[0].insertBefore(content + "\n");
        } else {
            this.replace(root, content + "\n");
        }
    }

    /**
     * extracts the C type string from a definition node.
     * @param {SourceNode} defNode - The definition identifier node.
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
            declNode = declNode.parent;
        }

        if (!declNode) return "void *";

        let suffix = "";
        // Check for pointer declarators in children
        const ptrs = declNode.find('pointer_declarator');
        for (const p of ptrs) {
            // Validate it wraps our identifier?
            if (this.isDescendant(declNode, p)) {
                suffix += "*";
            }
        }

        let typeNode = declNode.findChildByFieldName('type');
        if (!typeNode) {
            typeNode = declNode.children.find(c =>
                ['primitive_type', 'type_identifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(c.type)
            );
        }
        const baseType = typeNode ? typeNode.text : "void";

        return baseType + " " + suffix;
    }

    /**
     * Extracts function signature details.
     * @param {SourceNode} fnNode - The function_definition node.
     * @returns {{returnType: string, name: string, params: string}} Signature details.
     */
    getFunctionSignature(fnNode) {
        if (!fnNode) return { returnType: "void", name: "unknown", params: "()" };

        // 1. Find type
        let typeNode = fnNode.findChildByFieldName('type');
        if (!typeNode) {
            typeNode = fnNode.children.find(c => c.type.includes('type_specifier') || c.type === 'primitive_type');
        }
        const returnType = typeNode ? typeNode.text : "void";

        // 2. Find declarator
        let declarator = fnNode.findChildByFieldName('declarator');
        if (!declarator) {
            declarator = fnNode.children.find(c => c.type !== 'compound_statement' && c !== typeNode);
        }

        let funcDecl = declarator;
        while (funcDecl && (funcDecl.type === 'pointer_declarator' || funcDecl.type === 'parenthesized_declarator')) {
            funcDecl = funcDecl.findChildByFieldName('declarator') || funcDecl.children.find(c => c.type.includes('declarator'));
        }

        const nameNode = funcDecl ? (funcDecl.findChildByFieldName('declarator') || funcDecl.children[0]) : null;
        const name = nameNode ? nameNode.text : "unknown";

        const paramList = funcDecl ? (funcDecl.findChildByFieldName('parameters') || funcDecl.children.find(c => c.type === 'parameter_list')) : null;
        const params = paramList ? paramList.text : "()";

        let bodyNode = fnNode.findChildByFieldName('body') || fnNode.children.find(c => c.type === 'compound_statement');

        return { returnType, name, params, bodyNode, node: fnNode, nameNode };
    }

    /**
     * Finds the definition for a node or name.
     * @param {import('tree-sitter').SyntaxNode|string} target - The node or name.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition.
     */
    getDefinition(target) {
        return this.findDefinition(target);
    }

    /**
     * Finds the definition for a node or name.
     * @param {import('tree-sitter').SyntaxNode|string} target - The node or name.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition.
     */
    findDefinition(target, options = { variable: true, tag: true }) {
        const name = typeof target === 'string' ? target : target.text;
        if (!name) return null;

        let current = (typeof target === 'object' && target instanceof SourceNode) ? target.parent : null;
        if (!current && this.contextNode) current = this.contextNode;
        if (!current) current = this.root;

        while (current) {
            // Search identifier/type_identifier descendants in this scope
            const children = current.find(n => n.type === 'identifier' || n.type === 'type_identifier');

            for (const idNode of children) {
                if (idNode.text === name) {
                    let p = idNode.parent;
                    if (!p) continue;

                    // Tag check (struct/union/enum)
                    if (options.tag && p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') {
                        // Check if idNode is the name/tag (first child usually)
                        if (p.child(1) && p.child(1).id === idNode.id) {
                            return p;
                        }
                    }

                    // Variable/Function/Typedef check
                    if (options.variable) {
                        let d = p;
                        while (d && (d.type.endsWith('_declarator') || d.type === 'declarator')) {
                            d = d.parent;
                        }
                        if (d && (d.type === 'init_declarator' || d.type === 'parameter_declaration' || d.type === 'field_declaration' || d.type === 'declaration')) {
                            // Make sure we are in the 'declarator' field or position
                            return idNode;
                        }
                        if (d && d.type === 'type_definition') {
                            return idNode;
                        }
                    }
                }
            }

            if (current.type === 'translation_unit') break;
            current = current.parent;
        }

        return null;
    }

    /**
     * Finds references to a definition.
     * @param {import('tree-sitter').SyntaxNode} node - The definition node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} The references.
     */
    findReferences(node) {
        const name = node.text;
        if (!name) return [];

        const root = this.root;
        const ids = root.find('identifier');

        const refs = [];
        for (const idNode of ids) {
            if (idNode.text === name) {
                // Skip the definition node itself
                if (idNode === node) continue;

                // Verify this identifier refers to our definition
                const def = this.findDefinition(idNode);
                if (def && def === node) {
                    refs.push(idNode);
                }
            }
        }
        return refs;
    }

    /**
     * Transforms references to a definition intelligently:
     * - For references below the current node: applies callback immediately
     * - For references above the current node: creates deferred markers for later transformation
     * - Registers a transformation rule to handle dynamically generated references
     *
     * @param {import('tree-sitter').SyntaxNode} definitionNode - The definition node to find references for
     * @param {function(import('tree-sitter').SyntaxNode): string|null|undefined} callback - Transformation callback.
     *        Return: string (replace), null/"" (delete), undefined (no change)
     * @returns {string} Marker for deferred transformations (empty if all references were below)
     */
    withReferences(definitionNode, callback) {
        const originalName = definitionNode.text;
        // Register a transformation rule for this definition
        const rule = {
            id: this.registry.generateRuleId(),
            type: 'references',
            identity: {
                name: originalName,
                definitionNode: definitionNode
            },
            matcher: (node) => {
                if (node.type !== 'identifier') return false;
                if (node.text !== originalName) return false;

                // Resolves to our definition
                const def = this.findDefinition(node);
                return def === definitionNode;
            },
            callback: callback,
            active: true
        };

        this.registry.registerTransformRule(rule);
        return "";
    }

    /**
     * Finds and transforms a definition node intelligently.
     * Similar to withReferences but operates on the definition itself.
     *
     * @param {import('tree-sitter').SyntaxNode|string} target - The node or name to find definition for
     * @param {function(import('tree-sitter').SyntaxNode): string|null|undefined} callback - Transformation callback.
     *        Return: string (replace), null/"" (delete), undefined (no change)
     * @returns {string} Marker for deferred transformations (empty if definition was below)
     */
    withDefinition(target, callback) {
        const defNode = this.findDefinition(target);
        if (!defNode) return "";
        this.withNode(defNode, callback);
        return "";
    }

    /**
     * Transforms nodes matching a pattern intelligently.
     * Registers a transformation rule for re-evaluation on generated code.
     *
     * @param {string} nodeType - The node type to match (e.g., 'call_expression')
     * @param {function(import('tree-sitter').SyntaxNode, Object): boolean} matcher - Custom matcher function
     * @param {function(import('tree-sitter').SyntaxNode): string|null|undefined} callback - Transformation callback
     * @returns {string} Marker for deferred transformations
     */
    withPattern(nodeType, matcher, callback) {
        // Register a transformation rule for this pattern
        const rule = {
            id: this.registry.generateRuleId(),
            type: 'pattern',
            nodeType: nodeType,
            matcher: (node, helpers) => {
                if (node.type !== nodeType) return false;
                return matcher(node, helpers);
            },
            callback: callback,
            scope: this.contextNode,
            active: true
        };

        this.registry.registerTransformRule(rule);

        // Process existing nodes at root level
        return this.atRoot((root, helpers) => {
            helpers.walk(root, (node) => {
                if (node.type === nodeType) {
                    if (matcher(node, helpers)) {
                        const replacement = callback(node, helpers);
                        if (replacement !== undefined) {
                            helpers.replace(node, replacement === null ? '' : replacement);
                        }
                    }
                }
            });
        });
    }

    /**
     * Transforms nodes matching an S-expression query.
     * @param {import('tree-sitter').SyntaxNode} scope - The search scope.
     * @param {string} queryString - The S-expression query.
     * @param {function(import('tree-sitter').SyntaxNode, UppHelpersC): (string|null|undefined)} callback - Transformation callback.
     */
    withQuery(scope, queryString, callback) {
        const matches = this.query(queryString, scope);
        for (const match of matches) {
            // Usually we want to transform the main capture or all caps?
            // Query matches return named captures. If there's only one, use it.
            const captureNames = Object.keys(match.captures);
            if (captureNames.length > 0) {
                this.withNode(match.captures[captureNames[0]], (node, helpers) => callback(node, helpers));
            }
        }
    }

    /**
     * Transforms nodes matching a source fragment pattern.
     * @param {import('tree-sitter').SyntaxNode} scope - The search scope.
     * @param {string} pattern - The source fragment pattern.
     * @param {function(Object, UppHelpersC): (string|null|undefined)} callback - Transformation callback (receives captures).
     */
    withMatch(scope, pattern, callback) {
        this.matchAll(scope, pattern, (captures) => {
            if (captures && captures.node) {
                this.withNode(captures.node, (node, helpers) => callback(captures, helpers));
            }
        });
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
