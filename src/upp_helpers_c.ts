import { UppHelpersBase } from './upp_helpers_base.ts';
import type { Registry, RegistryContext } from './registry.ts';
import { SourceNode } from './source_tree.ts';
import type { MacroResult, AnySourceNode, InterpolationValue } from './types.ts';

export class FunctionSignature {
    public returnType: string;
    public name: string;
    public params: string;
    public node: SourceNode<CNodeTypes>;
    public nameNode?: SourceNode<CNodeTypes> | null;
    public bodyNode?: SourceNode<CNodeTypes> | null;

    constructor(
        returnType: string,
        name: string,
        params: string,
        node: SourceNode<CNodeTypes>,
        nameNode?: SourceNode<CNodeTypes> | null,
        bodyNode?: SourceNode<CNodeTypes> | null
    ) {
        this.returnType = returnType;
        this.name = name;
        this.params = params;
        this.node = node;
        this.nameNode = nameNode;
        this.bodyNode = bodyNode;
    }
}

export type CNodeTypes =
    | 'translation_unit'
    | 'preproc_include'
    | 'preproc_def'
    | 'preproc_function_def'
    | 'preproc_params'
    | 'preproc_call'
    | 'preproc_if'
    | 'preproc_ifdef'
    | 'preproc_else'
    | 'preproc_arg'
    | 'function_definition'
    | 'declaration'
    | 'type_definition'
    | 'struct_specifier'
    | 'union_specifier'
    | 'enum_specifier'
    | 'enum_specifier_contents'
    | 'enumerator'
    | 'parameter_list'
    | 'parameter_declaration'
    | 'attributable_declarator'
    | 'init_declarator'
    | 'pointer_declarator'
    | 'array_declarator'
    | 'function_declarator'
    | 'parenthesized_declarator'
    | 'identifier'
    | 'field_identifier'
    | 'type_identifier'
    | 'statement_identifier'
    | 'primitive_type'
    | 'sized_type_specifier'
    | 'type_qualifier'
    | 'storage_class_specifier'
    | 'compound_statement'
    | 'expression_statement'
    | 'if_statement'
    | 'while_statement'
    | 'do_statement'
    | 'for_statement'
    | 'return_statement'
    | 'break_statement'
    | 'continue_statement'
    | 'goto_statement'
    | 'switch_statement'
    | 'case_statement'
    | 'labeled_statement'
    | 'field_declaration_list'
    | 'field_declaration'
    | 'assignment_expression'
    | 'binary_expression'
    | 'unary_expression'
    | 'update_expression'
    | 'cast_expression'
    | 'pointer_expression'
    | 'sizeof_expression'
    | 'subscript_expression'
    | 'call_expression'
    | 'argument_list'
    | 'field_expression'
    | 'compound_literal_expression'
    | 'parenthesized_expression'
    | 'comma_expression'
    | 'conditional_expression'
    | 'string_literal'
    | 'number_literal'
    | 'char_literal'
    | 'null'
    | 'true'
    | 'false'
    | 'comment';

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
export class UppHelpersC extends UppHelpersBase<CNodeTypes> {
    /** Semantic caches: keyed by node id, cleared on any tree mutation. */
    public definitionCache: Map<string | number, SourceNode<CNodeTypes> | null> = new Map();
    public scopeCache: Map<string | number, SourceNode<CNodeTypes>[]> = new Map();
    public enclosingScopeCache: Map<string | number, SourceNode<CNodeTypes> | null> = new Map();

    clearSemanticCaches(): void {
        this.definitionCache.clear();
        this.scopeCache.clear();
        this.enclosingScopeCache.clear();
    }

    constructor(root: SourceNode<CNodeTypes>, registry: Registry, parentHelpers: UppHelpersBase<any> | null = null) {
        super(root, registry, parentHelpers);
    }

    /**
     * Finds the nearest enclosing C scope (compound_statement or translation_unit).
     * @returns {SourceNode<CNodeTypes> | null} The scope node or null.
     */
    findScope(): SourceNode<CNodeTypes> | null {
        const startNode = (this.lastConsumedNode && this.lastConsumedNode.parent) ? this.lastConsumedNode : this.contextNode;
        if (!startNode) return null;

        // 1. Try to find the nearest enclosing block
        const block = this.findEnclosing(startNode, ['compound_statement']);
        if (block) return block;

        // 2. If we are in a function definition but not inside the body (e.g. in parameters), find the body
        const fn = this.findEnclosing(startNode, ['function_definition']);
        if (fn && fn.named.body) return fn.named.body;

        // 3. Fallback to translation unit
        return this.findEnclosing(startNode, ['translation_unit']);
    }

    /**
     * Hoists content to the top of the file, skipping comments.
     * @param {string} content - The content to hoist.
     * @param {number} [_hoistIndex=0] - The index to hoist to.
     */
    hoist(content: string, _hoistIndex: number = 0): void {
        const root = this.findRoot();
        if (!root) throw new Error("helpers.hoist: Invalid root");
        if (root.children.length > 0) {
            root.children[0].insertBefore(content + "\n");
        } else {
            this.replace(root, content + "\n");
        }
    }

    /**
     * extracts the C type string from a definition node.
     * @param {SourceNode<CNodeTypes> | string | null} node - The identifier node or name.
     * @param {{ resolve?: boolean }} [options] - Options for type resolution.
     * @returns {string} The C type string (e.g. "char *").
     */
    getType(node: SourceNode<CNodeTypes> | string | null, options: { resolve?: boolean } = {}, _visited: Set<string> = new Set()): string {
        if (!node) return "";
        const target = typeof node === 'string' ? this.findDefinition(node) : node;
        if (!target) return "";

        let declNode: SourceNode<CNodeTypes> | undefined = target;
        let idNode: SourceNode<CNodeTypes> | undefined = (target.type === 'identifier' || target.type === 'type_identifier') ? target : undefined;

        if (!idNode) {
            while (declNode &&
                !['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
                declNode = declNode.parent || undefined;
            }
            if (!declNode) return "";

            if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
                idNode = declNode.child(1) || undefined; // The tag
                if (idNode && idNode.type !== 'type_identifier' && idNode.type !== 'identifier') idNode = undefined;
            } else {
                // For other declarations, find the identifier in the declarator, avoiding the body
                const declarator = declNode.named.declarator;
                if (declarator) {
                    idNode = declarator.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier')[0];
                } else {
                    const ids = declNode.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier');
                    idNode = declNode.type === 'type_definition' ? ids[ids.length - 1] : ids[0];
                }
            }
        } else {
            while (declNode &&
                !['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
                declNode = declNode.parent || undefined;
            }
        }

        if (!declNode) return "";

        let prefix = "";
        let suffix = "";

        if (idNode) {
            let p: SourceNode<CNodeTypes> | null = idNode;
            while (p && p !== declNode) {
                if (p.type === 'pointer_declarator') {
                    prefix += "*";
                } else if (p.type === 'array_declarator') {
                    suffix += "[]";
                }
                p = p.parent as SourceNode<CNodeTypes> | null;
            }
        }

        let typeNode = declNode.named.type;
        if (!typeNode) {
            typeNode = declNode.children.find(c =>
                ['primitive_type', 'type_identifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(c.type as string)
            );
            if (!typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type as string)) {
                typeNode = declNode;
            }
        }

        if (options.resolve && typeNode && typeNode.type === 'type_identifier') {
            let def = this.findDefinitionOrNull(typeNode.text, { variable: true, tag: true });

            // Cross-tree fallback: search loaded dependency trees for type definitions
            if (!def) {
                for (const depHelpers of this.registry.dependencyHelpers) {
                    def = (depHelpers as UppHelpersC).findDefinitionOrNull(typeNode.text, { variable: true, tag: true });
                    if (def) break;
                }
            }

            if (def && (def.type === 'type_definition' || def.type === 'struct_specifier' || def.type === 'union_specifier' || def.type === 'enum_specifier')) {
                // Ensure we don't resolve to the same node or a node we already visited
                if (def.id !== target.id && !_visited.has(String(def.id))) {
                    _visited.add(String(target.id));
                    const underlyingType = this.getType(def, options, _visited);
                    // Strip structural bodies before collecting stars
                    const cleanUnderlying = underlyingType.replace(/\{[^}]*\}/g, '');
                    const uStars = cleanUnderlying.match(/\*/g)?.join('') || "";
                    const uBase = underlyingType.replace(/\*/g, '').trim();
                    // Merge prefixes: current pointers + underlying pointers
                    const allStars = (prefix + uStars).trim();
                    const result = `${uBase}${allStars ? ' ' + allStars : ''}`.trim() + suffix;
                    return result.replace(/\s+/g, ' ');
                }
            }
        }

        let baseType = typeNode ? typeNode.text : "void";
        if (typeNode && ((typeNode.type as string) === 'struct_specifier' || (typeNode.type as string) === 'union_specifier' || (typeNode.type as string) === 'enum_specifier')) {
            const tag = typeNode.child(1);
            const kind = (typeNode.type as string).split('_')[0];
            baseType = tag ? `${kind} ${tag.text}` : typeNode.text;
        }

        let result = baseType || "void";
        if (prefix) result += " " + prefix;
        if (suffix) result += suffix;

        return result.trim().replace(/\s+/g, ' ');
    }

    /**
     * Returns the number of array dimensions wrapping an identifier.
     * @param {SourceNode<CNodeTypes>} defNode - The definition node.
     * @returns {number} Array depth.
     */
    getArrayDepth(defNode: SourceNode<CNodeTypes>): number {
        const type = this.getType(defNode);
        const matches = type.match(/\[\]/g);
        return matches ? matches.length : 0;
    }

    /**
     * Determines the lexical scope node for a given identifier.
     * @param {SourceNode<any>} node - The identifier node.
     * @returns {SourceNode<CNodeTypes>|null} The scope node.
     */
    getEnclosingScope(node: SourceNode<any>): SourceNode<CNodeTypes> | null {
        if (this.enclosingScopeCache.has(node.id)) {
            return this.enclosingScopeCache.get(node.id)!;
        }

        let p = node.parent || (node as any)._detachedParent;
        let counter = 0;
        let result: SourceNode<CNodeTypes> | null = null;

        while (p) {
            counter++;
            if (counter > 500) {
                console.error(`Extremely deep tree in getEnclosingScope! Depth > 500. Node: ${node.type} at ${node.startIndex}`);
                break;
            }
            if (p.type === 'compound_statement' || (p.type === 'translation_unit' && !p.parent)) {
                result = p as SourceNode<CNodeTypes>;
                break;
            }
            if (p.type === 'function_definition') {
                const declarator = p.named['declarator'];
                const parameters = declarator?.find('parameter_list')[0];
                const isInsideParams = parameters && (this.isDescendant(parameters, node) || parameters === node);

                if (declarator && (this.isDescendant(declarator, node) || declarator === node) && !isInsideParams) {
                    p = p.parent || (p as any)._detachedParent;
                    continue;
                }
                result = p as SourceNode<CNodeTypes>;
                break;
            }
            p = p.parent || (p as any)._detachedParent;
        }

        this.enclosingScopeCache.set(node.id, result);
        return result;
    }

    /**
     * Extracts function signature details including return type, name, parameters, and body.
     * @param {SourceNode<CNodeTypes>} fnNode - The function_definition node.
     * @returns {FunctionSignature} Signature details.
     */
    getFunctionSignature(fnNode: SourceNode<CNodeTypes>): FunctionSignature {
        const declarator = fnNode.named.declarator;
        let funcDeclarator = declarator;
        while (funcDeclarator && funcDeclarator.type !== 'function_declarator') {
            funcDeclarator = (funcDeclarator as any).named.declarator;
        }

        if (!funcDeclarator) {
            throw new Error("helpers.getFunctionSignature: function_declarator not found");
        }

        const nameNode = funcDeclarator.named.declarator;
        const name = nameNode ? nameNode.text : "";
        const params = funcDeclarator.named.parameters ? funcDeclarator.named.parameters.text : "()";
        const returnType = this.getType(fnNode);

        return new FunctionSignature(
            returnType,
            name,
            params,
            fnNode,
            nameNode,
            fnNode.named.body
        );
    }

    /**
     * Finds the definition for a node or name, returning null if not found.
     * @param {SourceNode<any>|string} target - The identifier node, a container node, or a scoping node (if name is provided).
     * @param {string | { variable?: boolean, tag?: boolean } | null} [nameOrOptions] - The name to find or options object.
     * @param {{ variable?: boolean, tag?: boolean }} [options] - Resolution options.
     * @returns {SourceNode<CNodeTypes>|null} The declaration/definition node or null.
     */
    findDefinitionOrNull(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> | null {
        try {
            return this.findDefinition(target, nameOrOptions, options);
        } catch (ex) {
            return null;
        }
    }

    /**
     * Finds the definition for a node or name, throwing an error if not found.
     * @param {SourceNode<any>|string} target - The identifier node, a container node, or a scoping node (if name is provided).
     * @param {string | { variable?: boolean, tag?: boolean } | null} [nameOrOptions] - The name to find or options object.
     * @param {{ variable?: boolean, tag?: boolean }} [options] - Resolution options.
     * @returns {SourceNode<CNodeTypes>} The declaration/definition node.
     */
    findDefinition(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> {
        let name: string | null = null;
        let startScope: SourceNode<any> | null = null;
        let finalOptions = (typeof nameOrOptions === 'object' && nameOrOptions !== null) ? { ...options, ...nameOrOptions } : options;

        let cacheKey: string | number | null = null;

        if (typeof target === 'string') {
            name = target;
            startScope = this.contextNode || this.findRoot();
        } else if (target instanceof SourceNode) {
            if (typeof nameOrOptions === 'string') {
                name = nameOrOptions;
                startScope = target;
            } else {
                let idNode = (target.type === 'identifier' || target.type === 'type_identifier') ? target : null;
                if (!idNode) {
                    const ids = target.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'type_identifier');
                    if (ids.length === 1) idNode = ids[0];
                }

                if (!idNode) throw new Error("helpers.findDefinition: no valid identifier found");
                name = (idNode as any).searchableText as string;
                startScope = idNode.parent;
                cacheKey = idNode.id; // Identifier-based caching
            }
        }

        if (!name || !startScope) throw new Error("helpers.findDefinition: no valid identifier or scope found");

        if (cacheKey !== null && this.definitionCache.has(cacheKey)) {
            const cached = this.definitionCache.get(cacheKey);
            if (cached) return cached;
        }

        const findInScope = (scope: SourceNode<CNodeTypes>) => {
            if (this.scopeCache.has(scope.id)) {
                return this.scopeCache.get(scope.id)!;
            }
            const allIds = scope.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'type_identifier');
            const filtered = allIds.filter((idNode: SourceNode<CNodeTypes>) => {
                return this.getEnclosingScope(idNode) === scope;
            });
            this.scopeCache.set(scope.id, filtered);
            return filtered;
        };

        let current: SourceNode<CNodeTypes> | null = startScope;
        let loopCounter = 0;
        while (current) {
            loopCounter++;
            if (loopCounter > 1000) {
                throw new Error(`Infinite loop detected in findDefinition up-tree traversal for '${name}'! current.type=${current.type}`);
            }
            const identifiers = findInScope(current);

            for (const idNode of identifiers) {
                if ((idNode as any).searchableText === name) {
                    let p: SourceNode<CNodeTypes> | null = idNode;
                    let isDeclarator = false;

                    while (p && p !== current) {
                        if ((p.type as string).endsWith('declarator') || p.type === 'init_declarator') {
                            if (p.type === 'init_declarator') {
                                let isInsideValue = false;
                                let walk: SourceNode<any> | null = idNode;
                                while (walk && walk !== p) {
                                    if (walk.parent === p && walk.fieldName === 'value') {
                                        isInsideValue = true;
                                        break;
                                    }
                                    walk = walk.parent;
                                }
                                if (isInsideValue) break;
                                isDeclarator = true;
                            } else {
                                isDeclarator = true;
                            }
                        }
                        if (p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') {
                            if (finalOptions.tag && p.child(1) && p.child(1)!.id === idNode.id) {
                                if (cacheKey !== null) this.definitionCache.set(cacheKey, p);
                                return p as SourceNode<CNodeTypes>;
                            }
                            break;
                        }
                        if (p.type === 'parameter_declaration' || p.type === 'declaration' || p.type === 'type_definition' || p.type === 'field_declaration' || p.type === 'function_definition') {
                            if (isDeclarator || (idNode.parent === p && idNode.fieldName !== 'type')) {
                                if (finalOptions.variable) {
                                    if (cacheKey !== null) this.definitionCache.set(cacheKey, p);
                                    return p as SourceNode<CNodeTypes>;
                                }
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
     * @param {SourceNode<CNodeTypes>} node - The definition node.
     * @returns {SourceNode<CNodeTypes>[]} The references.
     */
    findReferences(node: SourceNode<CNodeTypes>): SourceNode<CNodeTypes>[] {
        const root = this.findRoot();
        if (!root) return [];

        const idsInDef = node.find<CNodeTypes>((n: SourceNode<CNodeTypes>) =>
            n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier'
        );

        let idInDef = idsInDef.find(n => {
            let p = n.parent;
            while (p && p !== node) {
                if (p.type.endsWith('declarator') || p.type === 'init_declarator' || p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') return true;
                p = p.parent;
            }
            return false;
        });

        const name = idInDef ? idInDef.text : node.text;
        if (!name || (idInDef && idInDef.type !== 'identifier' && idInDef.type !== 'field_identifier' && idInDef.type !== 'type_identifier')) {
            // If we can't find a valid name (e.g. complex declarator without identifier), it shouldn't have references.
            return [];
        }

        const refs: SourceNode<CNodeTypes>[] = [];
        const ids = root.find<CNodeTypes>((n: SourceNode<CNodeTypes>) =>
            n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier'
        );

        for (const idNode of ids) {
            if (idNode.text === name) {
                const def = this.findDefinitionOrNull(idNode);
                if (def && def === node) {
                    refs.push(idNode);
                } else if (!node.parent && (node as any)._detachedParent) {
                    // Fallback for detached nodes: check name and scope equality
                    // If we can't find a direct identity match because 'node' is a detached fragment,
                    // we check if the reference resolves to something with the same name in the same scope.
                    const refScope = this.getEnclosingScope(idNode);
                    const defScope = this.getEnclosingScope(node);
                    if (refScope && defScope && (refScope === defScope || refScope.id === defScope.id)) {
                        refs.push(idNode);
                    }
                }
            }
        }
        return refs;
    }

    /**
     * Checks if the currently being transformed node is the declaration node
     * for the symbol we are tracking with withReferences.
     * @returns {boolean} True if the current node is the declaration.
     */
    isDeclaration(): boolean {
        return false;
    }

    /**
     * Registers a rule to transform any identifier that resolves to a specific definition.
     * This is robust against code rewrites as it doesn't depend on specific node instances.
     * @param {SourceNode<CNodeTypes>} definitionNode - The definition node to track.
     * @param {function(SourceNode<CNodeTypes>, UppHelpersC): string|null|undefined} callback - Transformation callback.
     */
    withReferences(definitionNode: SourceNode<CNodeTypes>, callback: (n: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
        const definitionId = definitionNode.id;

        // Find the actual identifier name node within the definition
        let idNode = (definitionNode.type === 'identifier' || definitionNode.type === 'type_identifier') ? definitionNode : null;
        if (!idNode) {
            const ids = definitionNode.find<CNodeTypes>(n => n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'field_identifier');
            // We want the node that is acting as the "declarator"
            idNode = ids.find(n => {
                let p = n.parent;
                while (p && p !== definitionNode) {
                    const t = p.type;
                    if (t.endsWith('declarator') || t === 'init_declarator' || t === 'struct_specifier' || t === 'union_specifier' || t === 'enum_specifier') return true;
                    p = p.parent;
                }
                return false;
            }) || ids.find(n => n.fieldName === 'declarator' || n.parent?.fieldName === 'declarator') || ids[ids.length - 1] || null;
        }

        if (!idNode) return;

        const declarationIdNode = idNode;
        const definitionName = idNode.text;
        const definitionScope = this.getEnclosingScope(definitionNode);
        const definitionScopeId = definitionScope ? definitionScope.id : null;

        this.registry.registerPendingRule({
            contextNode: this.findRoot()!,
            matcher: (node, helpers) => {
                if (node.type !== 'identifier' && node.type !== 'type_identifier' && node.type !== 'field_identifier') return false;

                // CRITICAL: We only match if the current text matches the definition name.
                // This avoids infinite loops for rename transformations.
                if (node.text !== definitionName) return false;

                const def = (helpers as UppHelpersC).findDefinitionOrNull(node);
                if (def) {
                    if (def.id === definitionId) {
                        return true;
                    }

                    // Fallback for morphed definitions: match by scope identity
                    const defScope = (helpers as UppHelpersC).getEnclosingScope(def);
                    if (defScope && definitionScopeId && defScope.id === definitionScopeId) {
                        return true;
                    }
                } else {
                    // Fallback for detached definitions (e.g. during macro transformation)
                    // If findDefinition returns null, check if the reference is lexically within the definition's scope.
                    // We only need to check if one of the enclosing scopes of the reference matches the definitionScopeId.
                    let walkScope: SourceNode<any> | null = (helpers as UppHelpersC).getEnclosingScope(node);
                    while (walkScope) {
                        if (definitionScopeId && walkScope.id === definitionScopeId) {
                            return true;
                        }
                        const p: SourceNode<any> | null = walkScope.parent || (walkScope as any)._detachedParent;
                        walkScope = p ? (helpers as UppHelpersC).getEnclosingScope(p) : null;
                    }
                }
                return false;
            },
            callback: (node, helpers) => {
                const shadowHelpers = Object.create(helpers);
                shadowHelpers.isDeclaration = () => node.id === declarationIdNode.id;
                return callback(node as SourceNode<CNodeTypes>, shadowHelpers as UppHelpersC);
            }
        });
    }

    /**
     * Replaces placeholders in an array of nodes/strings.
     * @param {InterpolationValue[]} values The values to expand.
     * @param {CNodeTypes} parentType The tree-sitter node type of the parent.
     * @returns {InterpolationValue[]} The expanded list of nodes/text.
     */
    getArrayExpansion(values: InterpolationValue[], _parentType: CNodeTypes): InterpolationValue[] {
        return values;
    }
}
