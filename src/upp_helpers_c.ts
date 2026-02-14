import { UppHelpersBase } from './upp_helpers_base.ts';
import type { Invocation, Registry, RECURSION_LIMITER_ENABLED, TransformRule } from './registry.ts';
import { PatternMatcher } from './pattern_matcher.ts';
import { SourceNode } from './source_tree.ts';
import Parser from 'tree-sitter';

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
class UppHelpersC extends UppHelpersBase {
    public matcher: PatternMatcher;
    public transformKey?: string;

    constructor(root: SourceNode, registry: Registry, parentHelpers: UppHelpersBase | null = null) {
        super(root, registry, parentHelpers);
        // Use a dedicated parser for patterns to avoid invalidating the main registry parser/tree
        const patternParser = new Parser();
        patternParser.setLanguage(registry.language);
        this.matcher = new PatternMatcher((src) => patternParser.parse(src), registry.language);
    }

    /**
     * Matches a pattern against code.
     * @param {SourceNode} node - Target node.
     * @param {string | string[]} src - Pattern source code.
     * @param {function(any): any} [callback] - Callback with captures.
     * @param {any} [options] - Match options.
     * @returns {any} Result of callback or captures object (or null).
     */
    match(node: SourceNode, src: string | string[], callback?: (captures: Record<string, SourceNode>) => any, options: { deep?: boolean } = {}): any {
        if (!node) throw new Error("upp.match: Argument 1 must be a valid node.");

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true;

        for (const s of srcs) {
            const result = this.matcher.match(node as any, s, deep);
            if (result) {
                if (callback) return callback(result as Record<string, SourceNode>);
                return result;
            }
        }
        return null;
    }

    /**
     * Matches all occurrences of a pattern.
     * @param {SourceNode} node - Target node.
     * @param {string | string[]} src - Pattern source code.
     * @param {function(any): any} [callback] - Optional callback.
     * @param {any} [options] - Options.
     * @returns {any[]} Matches.
     */
    matchAll(node: SourceNode, src: string | string[], callback?: (match: { node: SourceNode, captures: Record<string, SourceNode> }) => any, options: { deep?: boolean } = {}): any[] {
        if (!(node instanceof SourceNode)) throw new Error("upp.matchAll: Argument 1 must be a valid node.");

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true || (options.deep !== false && node.type === 'translation_unit');

        const allMatches: any[] = [];
        const seenIds = new Set<number | string>();

        for (const s of srcs) {
            const matches = this.matcher.matchAll(node as any, s, deep);
            for (const m of matches) {
                if (m.node && !seenIds.has(m.node.id)) {
                    const matchNode = node.tree.wrap(m.node);
                    if (matchNode) {
                        const captures: Record<string, SourceNode> = {};
                        for (const key in m) {
                            if (key !== 'node' && m[key]) {
                                const wrapped = node.tree.wrap(m[key]);
                                if (wrapped) captures[key] = wrapped;
                            }
                        }
                        allMatches.push({ node: matchNode, captures: captures });
                        seenIds.add(m.node.id);
                    }
                }
            }
        }

        if (callback) {
            return allMatches.map(m => callback(m as { node: SourceNode, captures: Record<string, SourceNode> }));
        }
        return allMatches;
    }

    /**
     * Replaces all matches of a pattern.
     * @param {SourceNode} node - Scope.
     * @param {string} src - Pattern.
     * @param {function(any): string | null | undefined} callback - Replacement callback.
     * @param {any} [options] - Options.
     */
    matchReplace(node: SourceNode, src: string, callback: (match: { node: SourceNode, captures: Record<string, SourceNode> }) => string | null | undefined, options: { deep?: boolean } = {}): void {
        this.matchAll(node, src, (match) => {
            if (match && match.node) {
                // Automatic recursion avoidance
                const key = (this as any).transformKey + "::" + src;

                if ((this as any).transformKey) {
                    if ((this.registry as any).visit(key, match.node)) {
                        const replacement = callback(match.captures as any);
                        if (replacement !== null && replacement !== undefined) {
                            this.replace(match.node, replacement);
                        }
                    }
                } else {
                    const replacement = callback(match.captures as any);
                    if (replacement !== null && replacement !== undefined) {
                        this.replace(match.node, replacement);
                    }
                }
            }
        }, { ...options, deep: true }); // Default to deep for matchReplace
    }
    /**
     * Hoists content to the top of the file, skipping comments.
     * @param {string} content - The content to hoist.
     * @param {number} [_hoistIndex=0] - The index to hoist to.
     */
    hoist(content: string, _hoistIndex: number = 0): void {
        const root = this.root; // Stable root
        if (root.children.length > 0) {
            root.children[0].insertBefore(content + "\n");
        } else {
            this.replace(root, content + "\n");
        }
    }

    /**
     * extracts the C type string from a definition node.
     * @param {SourceNode} node - The definition identifier node.
     * @returns {string} The C type string (e.g. "char *").
     */
    getType(node: SourceNode): string {
        if (!node) throw new Error("helpers.getType: Invalid node");

        let idNode = (node.type === 'identifier' || node.type === 'type_identifier') ? node : null;
        let declNode: SourceNode | null = node;

        if (!idNode) {
            // Find the declaration/parameter/field/typedef container if not already one
            while (declNode &&
                declNode.type !== 'declaration' &&
                declNode.type !== 'parameter_declaration' &&
                declNode.type !== 'field_declaration' &&
                declNode.type !== 'type_definition' &&
                declNode.type !== 'function_definition' &&
                declNode.type !== 'struct_specifier' &&
                declNode.type !== 'union_specifier' &&
                declNode.type !== 'enum_specifier') {
                declNode = declNode.parent;
            }

            if (!declNode) throw new Error("helpers.getType: Node is not a declaration");

            // Find the primary identifier in this declaration to trace declarators
            const ids = declNode.find((n: SourceNode) => n.type === 'identifier' || n.type === 'type_identifier');
            idNode = ids.find((id: SourceNode) => {
                let p = id.parent;
                while (p && p !== declNode) {
                    if (p.type.endsWith('declarator') || p.type === 'init_declarator') return true;
                    p = p.parent;
                }
                return false;
            }) || ids[0];
        } else {
            // Identifier provided, find its declaration container
            while (declNode &&
                declNode.type !== 'declaration' &&
                declNode.type !== 'parameter_declaration' &&
                declNode.type !== 'field_declaration' &&
                declNode.type !== 'type_definition' &&
                declNode.type !== 'function_definition' &&
                declNode.type !== 'struct_specifier' &&
                declNode.type !== 'union_specifier' &&
                declNode.type !== 'enum_specifier') {
                declNode = declNode.parent;
            }
        }

        if (!declNode) throw new Error("helpers.getType: Could not find declaration container");

        let prefix = "";
        let suffix = "";

        // Walk up from the identifier to the declaration to collect pointers and arrays
        if (idNode) {
            let p: SourceNode | null = idNode;
            while (p && p !== declNode) {
                if (p.type === 'pointer_declarator') {
                    prefix += "*";
                } else if (p.type === 'array_declarator') {
                    suffix += "[]";
                }
                p = p.parent;
            }
        }

        let typeNode = declNode.findChildByFieldName('type');
        if (!typeNode) {
            typeNode = declNode.children.find(c =>
                ['primitive_type', 'type_identifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(c.type)
            ) || null;
            // If declNode is a specifier itself, it's the type
            if (!typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
                typeNode = declNode;
            }
        }

        let baseType = typeNode ? typeNode.text : "void";
        if (typeNode && (typeNode.type === 'struct_specifier' || typeNode.type === 'union_specifier' || typeNode.type === 'enum_specifier')) {
            // For complex specifiers, just get the tag part if possible
            const tag = typeNode.child(1);
            const kind = typeNode.type.split('_')[0];
            baseType = tag ? `${kind} ${tag.text}` : typeNode.text;
        }

        let result = baseType;
        if (prefix) result += " " + prefix;
        if (suffix) result += suffix;

        return result.trim();
    }

    /**
     * Returns the number of array dimensions wrapping an identifier.
     * @param {SourceNode} defNode - The definition node.
     * @returns {number} Array depth.
     */
    getArrayDepth(defNode: SourceNode): number {
        if (!defNode) return 0;
        let depth = 0;
        let p: SourceNode | null = defNode;
        while (p) {
            if (p.type === 'array_declarator') depth++;
            // Stop at declaration boundary
            if (['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition'].includes(p.type)) break;
            p = p.parent;
        }
        return depth;
    }

    /**
     * Determines the lexical scope node for a given identifier.
     * @param {SourceNode} node - The identifier node.
     * @returns {SourceNode|null} The scope node.
     */
    getEnclosingScope(node: SourceNode): SourceNode | null {
        if (!node) return null;
        let p = node.parent;
        while (p) {
            if (['compound_statement', 'translation_unit', 'field_declaration_list', 'enumerator_list'].includes(p.type)) {
                return p;
            }
            if (p.type === 'function_definition') {
                // If the identifier is the function name, its scope is the PARENT scope
                // If it's a parameter, its scope is the function_definition itself.
                const sig = this.getFunctionSignature(p);
                if (sig.nameNode && (sig.nameNode === node || this.isDescendant(sig.nameNode, node))) {
                    p = p.parent;
                    continue;
                }
                return p;
            }
            p = p.parent;
        }
        return null;
    }

    /**
     * Extracts function signature details.
     * @param {SourceNode} fnNode - The function_definition node.
     * @returns {any} Signature details.
     */
    getFunctionSignature(fnNode: SourceNode): any {
        if (!fnNode) return { returnType: "void", name: "unknown", params: "()" };

        // 1. Find type
        let typeNode = fnNode.findChildByFieldName('type');
        if (!typeNode) {
            typeNode = fnNode.children.find(c => c.type.includes('type_specifier') || c.type === 'primitive_type') || null;
        }
        const returnType = typeNode ? typeNode.text : "void";

        // 2. Find declarator
        let declarator = fnNode.findChildByFieldName('declarator');
        if (!declarator) {
            declarator = fnNode.children.find(c => c.type !== 'compound_statement' && c !== typeNode) || null;
        }

        let funcDecl = declarator;
        while (funcDecl && (funcDecl.type === 'pointer_declarator' || funcDecl.type === 'parenthesized_declarator')) {
            funcDecl = funcDecl.findChildByFieldName('declarator') || funcDecl.children.find(c => c.type.includes('declarator')) || null;
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
     * @param {SourceNode|string} target - The identifier node, a container node with a single identifier, or a scoping node (if name is provided).
     * @param {string|any} [nameOrOptions] - The name to find (if target is a scope) or options object.
     * @param {any} [options] - Resolution options { variable: true, tag: true }.
     * @returns {SourceNode|null} The declaration/definition node.
     */
    findDefinitionOrNull(target: SourceNode | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode | null {
        try {
            return this.findDefinition(target, nameOrOptions, options);
        } catch (ex) {
            return null;
        }
    }

    /**
     * Finds the definition for a node or name.
     * @param {SourceNode|string} target - The identifier node, a container node with a single identifier, or a scoping node (if name is provided).
     * @param {string|any} [nameOrOptions] - The name to find (if target is a scope) or options object.
     * @param {any} [options] - Resolution options { variable: true, tag: true }.
     * @returns {SourceNode} The declaration/definition node.
     */
    findDefinition(target: SourceNode | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode {
        let name: string | null = null;
        let startScope: SourceNode | null = null;
        let finalOptions = (typeof nameOrOptions === 'object' && nameOrOptions !== null) ? { ...options, ...nameOrOptions } : options;

        if (typeof target === 'string') {
            name = target;
            startScope = this.contextNode || this.root;
        } else if (target instanceof SourceNode) {
            if (typeof nameOrOptions === 'string') {
                name = nameOrOptions;
                startScope = target;
            } else {
                // target is the identifier or a node containing one
                let idNode = (target.type === 'identifier' || target.type === 'type_identifier') ? target : null;
                if (!idNode) {
                    const ids = target.find((n: SourceNode) => n.type === 'identifier' || n.type === 'type_identifier');
                    if (ids.length === 1) idNode = ids[0];
                }

                if (!idNode) throw new Error("helpers.findDefinition: no valid identifier found");
                name = idNode.searchableText as string;
                startScope = target.parent;
            }
        }

        if (!name || !startScope) throw new Error("helpers.findDefinition: no valid identifier or scope found");

        const findInScope = (scope: SourceNode) => {
            return scope.find((n: SourceNode) => n.type === 'identifier' || n.type === 'type_identifier').filter((idNode: SourceNode) => {
                return this.getEnclosingScope(idNode) === scope;
            });
        };

        let current: SourceNode | null = startScope;
        while (current) {
            const identifiers = findInScope(current);

            for (const idNode of identifiers) {
                if (idNode.searchableText === name) {
                    // Walk up to see what kind of occurrence this is
                    let p: SourceNode | null = idNode;
                    let isDeclarator = false;

                    while (p && p !== current) {
                        if (p.type.endsWith('declarator') || p.type === 'init_declarator') {
                            // If we hit an init_declarator, we must ensure we are in the 'declarator' branch, not 'value'
                            if (p.type === 'init_declarator') {
                                // idNode.parent might be the declarator, or deep below it.
                                // We check if the path up from idNode to p goes through p.childForFieldName('value')
                                let isInsideValue = false;
                                let walk: SourceNode | null = idNode;
                                while (walk && walk !== p) {
                                    if (walk.parent === p && walk.fieldName === 'value') {
                                        isInsideValue = true;
                                        break;
                                    }
                                    walk = walk.parent;
                                }
                                if (isInsideValue) {
                                    // Usage in initializer, not a declarator occurrence
                                    break;
                                }
                                isDeclarator = true;
                            } else {
                                isDeclarator = true;
                            }
                        }
                        if (p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') {
                            if (finalOptions.tag && p.child(1) && p.child(1)!.id === idNode.id) {
                                return p; // Found a tag definition
                            }
                            // If it's not the name, it's a usage inside the specifier (ignore for variables)
                            break;
                        }
                        if (p.type === 'parameter_declaration' || p.type === 'declaration' || p.type === 'type_definition' || p.type === 'field_declaration' || p.type === 'function_definition') {
                            // Check if we hit the declaration via a declarator or direct child (except 'type' field)
                            // For parameter_declaration/field_declaration, we also check fieldName
                            if (isDeclarator || (idNode.parent === p && idNode.fieldName !== 'type')) {
                                if (finalOptions.variable) return p;
                            }
                            break;
                        }
                        p = p.parent;
                    }
                }
            }

            if (current.type === 'translation_unit') break;
            current = current.parent;
        }

        throw new Error(`No definition for '${name}' found`);
    }

    /**
     * Finds references to a definition.
     * @param {SourceNode} node - The definition node.
     * @returns {SourceNode[]} The references.
     */
    findReferences(node: SourceNode): SourceNode[] {
        if (!node || node.type === 'identifier' || node.type === 'type_identifier') {
            this.error(node, `findReferences: Expected declaration/definition node, found ${node ? node.type : 'null'}`);
        }

        const idInDef = node.find((n: SourceNode) => n.type === 'identifier')[0];
        const name = idInDef ? idInDef.text : node.text;
        if (!name) return [];

        const root = this.root;
        const ids = root.find((n: SourceNode) => n.type === 'identifier');

        const refs: SourceNode[] = [];
        for (const idNode of ids) {
            if (idNode.text === name) {
                // Skip the identifier inside the definition itself
                if (idInDef && idNode === idInDef) continue;

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
     * @param {SourceNode} definitionNode - The definition node to find references for
     * @param {function(SourceNode): string|null|undefined} callback - Transformation callback.
     *        Return: string (replace), null/"" (delete), undefined (no change)
     * @returns {string} Marker for deferred transformations (empty if all references were below)
     */
    withReferences(definitionNode: SourceNode, callback: (n: SourceNode) => string | null | undefined): string {
        if (!definitionNode || definitionNode.type === 'identifier' || definitionNode.type === 'type_identifier') {
            this.error(definitionNode, `withReferences: Expected declaration/definition node, found ${definitionNode ? definitionNode.type : 'null'}`);
        }

        const idInDef = definitionNode.find((n: SourceNode) => n.type === 'identifier' || n.type === 'field_identifier')[0];
        if (!idInDef) {
            this.error(definitionNode, "withReferences: Could not find identifier in definition node");
        }
        const originalName = idInDef.text;

        // Register a transformation rule for this definition
        const rule = {
            id: (this.registry as any).generateRuleId(),
            type: 'references',
            identity: {
                name: originalName,
                definitionNode: definitionNode
            },
            matcher: (node: SourceNode) => {
                if (node.type !== 'identifier' && node.type !== 'field_identifier') return false;
                if (node.text !== originalName) return false;

                // Resolves to our definition
                // We must be robust against the definition itself having been renamed
                // Find the identifier currently in the tree for this definition
                const currentIdInDef = definitionNode.find((n: SourceNode) => n.type === 'identifier' || n.type === 'field_identifier')[0] || idInDef;
                const oldCaptured = currentIdInDef._capturedText;
                currentIdInDef._capturedText = originalName; // Force it to resolve as if it still has the old name
                try {
                    const def = this.findDefinition(node);
                    return def === definitionNode;
                } finally {
                    currentIdInDef._capturedText = oldCaptured;
                }
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
     * @param {SourceNode|string} target - The node or name to find definition for
     * @param {function(SourceNode): string|null|undefined} callback - Transformation callback.
     *        Return: string (replace), null/"" (delete), undefined (no change)
     * @returns {string} Marker for deferred transformations (empty if definition was below)
     */
    withDefinition(target: SourceNode | string, callback: (n: SourceNode, helpers: UppHelpersC) => string | null | undefined): string {
        const defNode = this.findDefinition(target);
        if (!defNode) return "";
        this.withNode(defNode, callback as any);
        return "";
    }

    /**
     * Transforms nodes matching a pattern intelligently.
     * Registers a transformation rule for re-evaluation on generated code.
     *
     * @param {string} nodeType - The node type to match (e.g., 'call_expression')
     * @param {function(SourceNode, UppHelpersC): boolean} matcher - Custom matcher function
     * @param {function(SourceNode, UppHelpersC): string|null|undefined} callback - Transformation callback
     * @returns {string} Marker for deferred transformations
     */
    withPattern(nodeType: string, matcher: (node: SourceNode, helpers: UppHelpersC) => boolean, callback: (node: SourceNode, helpers: UppHelpersC) => string | null | undefined): string {
        // Register a transformation rule for this pattern
        const rule: TransformRule = {
            id: (this.registry as any).generateRuleId(),
            type: 'pattern',
            nodeType: nodeType,
            matcher: (node: SourceNode, helpers: UppHelpersC) => {
                if (node.type !== nodeType) return false;
                return matcher(node, helpers);
            },
            callback: callback,
            scope: this.contextNode,
            active: true
        } as any;

        this.registry.registerTransformRule(rule);

        // Process existing nodes at root level
        return this.atRoot((root, helpers) => {
            helpers.walk(root, (node) => {
                if (node.type === nodeType) {
                    if (matcher(node, helpers as UppHelpersC)) {
                        const replacement = callback(node, helpers as UppHelpersC);
                        if (replacement !== undefined) {
                            helpers.replace(node, replacement === null ? '' : replacement);
                        }
                    }
                }
            });
        });
    }

    /**
     * Transforms nodes matching a source fragment pattern.
     * @param {SourceNode} scope - The search scope.
     * @param {string} pattern - The source fragment pattern.
     * @param {function(any, UppHelpersC): (string|null|undefined)} callback - Transformation callback (receives captures).
     */
    withMatch(scope: SourceNode, pattern: string, callback: (captures: Record<string, SourceNode>, helpers: UppHelpersC) => string | null | undefined): void {
        this.matchAll(scope, pattern, (match) => {
            if (match && match.node) {
                this.withNode(match.node, ((node: SourceNode, helpers: UppHelpersBase) => callback(match.captures, helpers as UppHelpersC)) as any);
            }
        });
    }

}

export { UppHelpersC };
