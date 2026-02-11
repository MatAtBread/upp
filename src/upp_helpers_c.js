import { UppHelpersBase } from './upp_helpers_base.js';
import { RECURSION_LIMITER_ENABLED } from './registry.js';
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
        // Use a dedicated parser for patterns to avoid invalidating the main registry parser/tree
        const patternParser = new Parser();
        patternParser.setLanguage(registry.language);
        this.matcher = new PatternMatcher((src) => patternParser.parse(src), registry.language);
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
        if (!fnNode) return { returnType: "void", name: "unknown", params: "()" };

        // 1. Find type
        let typeNode = this.childForFieldName(fnNode, 'type');
        if (!typeNode) {
            // Find first child that is a type specifier or primitive
            for (let i = 0; i < fnNode.childCount; i++) {
                const c = fnNode.child(i);
                if (c.type.includes('type_specifier') || c.type === 'primitive_type') {
                    typeNode = c;
                    break;
                }
            }
        }
        const returnType = typeNode ? typeNode.text : "void";

        // 2. Find declarator
        let declarator = this.childForFieldName(fnNode, 'declarator');
        if (!declarator) {
             // Heuristic: find first non-type, non-body named sibling
             for (let i = 0; i < fnNode.childCount; i++) {
                 const c = fnNode.child(i);
                 if (c.isNamed && c.type !== 'compound_statement' && c !== typeNode) {
                     declarator = c;
                     break;
                 }
             }
        }

        let funcDecl = declarator;
        while (funcDecl && (funcDecl.type === 'pointer_declarator' || funcDecl.type === 'parenthesized_declarator')) {
            funcDecl = this.childForFieldName(funcDecl, 'declarator') ||
                       funcDecl.namedChildren.find(c => c.type.includes('declarator'));
        }

        // 3. Find name and params from funcDecl (usually a function_declarator)
        // function_declarator: declarator: _declarator parameters: parameter_list
        const nameNode = funcDecl ? (this.childForFieldName(funcDecl, 'declarator') || funcDecl.namedChild(0)) : null;
        const name = nameNode ? nameNode.text : "unknown";

        const paramList = funcDecl ? (this.childForFieldName(funcDecl, 'parameters') || funcDecl.namedChildren.find(c => c.type === 'parameter_list')) : null;
        const params = paramList ? paramList.text : "()";

        // 4. Find body
        let bodyNode = this.childForFieldName(fnNode, 'body');
        if (!bodyNode) {
            bodyNode = fnNode.namedChildren.find(c => c.type === 'compound_statement');
        }

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
    findDefinition(target) {
        const name = typeof target === 'string' ? target : target.text;
        if (!name) return null;

        let current = (typeof target === 'object' && target.__internal_raw_node) ? target.__internal_raw_node.parent : null;
        if (!current && this.contextNode) current = this.contextNode.__internal_raw_node || this.contextNode;
        if (!current) current = this.context.tree.rootNode;

        while (current) {
            // Find declarations in this scope
            const queryStr = `
                (declaration
                    declarator: (_) @name)
                (parameter_declaration
                    declarator: (_) @name)
                (function_definition
                    declarator: (function_declarator declarator: (_) @name))
                (type_definition
                    declarator: (_) @name)
            `;
            const matches = this.query(queryStr, current);

            for (const match of matches) {
                // The @name capture might be the actual identifier or a recursive declarator
                let n = match.captures.name;
                while (n && n.type !== 'identifier' && n.type !== 'type_identifier') {
                    n = this.childForFieldName(n, 'declarator') || n.namedChildren.find(c => c.type === 'identifier' || c.type === 'type_identifier' || c.type.endsWith('_declarator'));
                    if (n && (n.type === 'identifier' || n.type === 'type_identifier')) break;
                    // If we find another declarator, keep going
                }

                if (n && n.text === name) {
                    return n;
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

        const root = this.registry.mainTree ? this.registry.mainTree.rootNode : this.context.tree.rootNode;
        const queryStr = `(identifier) @id`;
        const matches = this.query(queryStr, root);

        const refs = [];
        for (const match of matches) {
            const idNode = match.captures.id;
            if (idNode.text === name) {
                // Skip the definition node itself
                if (idNode.startIndex === node.startIndex && idNode.endIndex === node.endIndex) continue;

                // Verify this identifier refers to our definition
                const def = this.findDefinition(idNode);
                if (def && def.startIndex === node.startIndex && def.endIndex === node.endIndex) {
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
        const references = this.findReferences(definitionNode);

        // Register a transformation rule for this pattern
        // This allows the rule to be re-evaluated on dynamically generated code
        const rule = {
            id: this.registry.generateRuleId(),
            type: 'references',
            identity: {
                name: definitionNode.text || this.getName(definitionNode),
                definitionNode: definitionNode
            },
            matcher: (node, helpers) => {
                // Check if node is an identifier with the right name
                if (node.type !== 'identifier') return false;
                if (node.text !== rule.identity.name) return false;

                // Find which definition this identifier refers to
                const def = helpers.findDefinition(node);
                if (!def) return false;

                // Walk up to find the declaration node
                let declNode = def;
                while (declNode &&
                       declNode.type !== 'declaration' &&
                       declNode.type !== 'parameter_declaration' &&
                       declNode.type !== 'function_definition') {
                    declNode = declNode.parent;
                }

                // Compare node objects (works due to depth-first guarantees)
                return declNode === rule.identity.definitionNode;
            },
            callback: callback,
            scope: this.contextNode,
            active: true
        };

        this.registry.registerTransformRule(rule);

        // Process existing references
        if (!references || references.length === 0) return '';

        const currentPos = this.contextNode ? this.contextNode.startIndex : 0;
        let hasAboveReferences = false;

        // Process references below current position immediately
        for (const ref of references) {
            if (ref.startIndex >= currentPos) {
                // Below current node - transform immediately
                const replacement = callback(ref, this);
                if (replacement !== undefined) {
                    // null or "" deletes, string replaces, undefined skips
                    this.replace(ref, replacement === null ? '' : replacement);
                }
            } else {
                hasAboveReferences = true;
            }
        }

        // For references above, create a deferred transformation
        if (hasAboveReferences) {
            return this.atRoot((root, helpers) => {
                for (const ref of references) {
                    if (ref.startIndex < currentPos) {
                        const replacement = callback(ref, helpers);
                        if (replacement !== undefined) {
                            helpers.replace(ref, replacement === null ? '' : replacement);
                        }
                    }
                }
            });
        }

        return '';
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
        if (!defNode) return '';

        const currentPos = this.contextNode ? this.contextNode.startIndex : 0;

        if (defNode.startIndex >= currentPos) {
            // Below current node - transform immediately
            const replacement = callback(defNode);
            if (replacement !== undefined) {
                this.replace(defNode, replacement === null ? '' : replacement);
            }
            return '';
        } else {
            // Above current node - defer transformation
            return this.atRoot((root, helpers) => {
                const replacement = callback(defNode);
                if (replacement !== undefined) {
                    helpers.replace(defNode, replacement === null ? '' : replacement);
                }
            });
        }
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
