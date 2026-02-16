import { UppHelpersBase } from './upp_helpers_base.ts';
import type { Registry, TransformRule } from './registry.ts';
import { PatternMatcher } from './pattern_matcher.ts';
import { SourceNode, SourceTree } from './source_tree.ts';
import Parser from 'tree-sitter';

export type CNodeTypes =
    | 'translation_unit'
    | 'function_definition'
    | 'declaration'
    | 'identifier'
    | 'type_identifier'
    | 'field_identifier'
    | 'statement_identifier'
    | 'preproc_def'
    | 'preproc_include'
    | 'preproc_ifdef'
    | 'preproc_if'
    | 'preproc_else'
    | 'preproc_elif'
    | 'preproc_endif'
    | 'type_definition'
    | 'compound_statement'
    | 'pointer_declarator'
    | 'array_declarator'
    | 'parameter_declaration'
    | 'field_declaration'
    | 'struct_specifier'
    | 'union_specifier'
    | 'enum_specifier'
    | 'primitive_type'
    | 'parameter_list'
    | 'argument_list'
    | 'initializer_list'
    | 'init_declarator'
    | 'parenthesized_declarator'
    | 'enumerator_list'
    | 'field_declaration_list'
    | 'expression_statement'
    | 'if_statement'
    | 'for_statement'
    | 'while_statement'
    | 'do_statement'
    | 'return_statement'
    | 'break_statement'
    | 'continue_statement'
    | 'labeled_statement'
    | 'goto_statement'
    | 'switch_statement'
    | 'case_statement'
    | 'default_statement'
    | 'cast_expression'
    | 'unary_expression'
    | 'binary_expression'
    | 'conditional_expression'
    | 'assignment_expression'
    | 'comma_expression'
    | 'subscript_expression'
    | 'call_expression'
    | 'field_expression'
    | 'parenthesized_expression'
    | 'number_literal'
    | 'string_literal'
    | 'char_literal'
    | 'abstract_pointer_declarator'
    | 'type_descriptor'
    | 'storage_class_specifier'
    | 'type_qualifier'
    | 'pointer_declarator'
    | 'function_declarator'
    | 'array_declarator'
    | 'parenthesized_declarator'
    | 'struct_specifier'
    | 'union_specifier'
    | 'enum_specifier'
    | 'enumerator'
    | 'field_declaration'
    | 'parameter_declaration'
    | 'translation_unit'
    | 'attributed_statement'
    | (string & {});

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
class UppHelpersC extends UppHelpersBase<CNodeTypes> {
    public matcher: PatternMatcher;
    public transformKey?: string;

    constructor(root: SourceNode<CNodeTypes>, registry: Registry, parentHelpers: UppHelpersBase<any> | null = null) {
        super(root, registry, parentHelpers);
        // Use a dedicated parser for patterns to avoid invalidating the main registry parser/tree
        const patternParser = new Parser();
        patternParser.setLanguage(registry.language as any);
        this.matcher = new PatternMatcher((src) => patternParser.parse(src), registry.language as any);
    }

    /**
     * Matches a pattern against code.
     * @param {SourceNode<any>} node - Target node.
     * @param {string | string[]} src - Pattern source code.
     * @param {function(any): any} [callback] - Callback with captures.
     * @param {any} [options] - Match options.
     * @returns {any} Result of callback or captures object (or null).
     */
    match(node: SourceNode<any>, src: string | string[], callback?: (captures: Record<string, any>) => any, options: { deep?: boolean } = {}): any {
        if (!node) throw new Error("upp.match: Argument 1 must be a valid node.");

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true;

        for (const s of srcs) {
            const result = this.matcher.match(node as any, s, deep);
            if (result) {
                const captures: Record<string, any> = {};
                for (const key in result) {
                    const val = result[key];
                    if (Array.isArray(val)) {
                        captures[key] = val.map(n => node.tree.wrap(n)).filter(Boolean);
                    } else if (val && (val as any).id !== undefined) {
                        captures[key] = node.tree.wrap(val as any);
                    } else {
                        captures[key] = val;
                    }
                }
                if (callback) return callback({ ...captures, node: captures.node } as any);
                return captures;
            }
        }
        return null;
    }

    /**
     * Matches all occurrences of a pattern.
     * @param {SourceNode<any>} node - Target node.
     * @param {string | string[]} src - Pattern source code.
     * @param {function(any): any} [callback] - Optional callback.
     * @param {any} [options] - Options.
     * @returns {any[]} Matches.
     */
    matchAll(node: SourceNode<any>, src: string | string[], callback?: (match: { node: SourceNode<CNodeTypes>, captures: Record<string, any> }) => any, options: { deep?: boolean } = {}): any[] {
        if (!(node instanceof SourceNode)) throw new Error("upp.matchAll: Argument 1 must be a valid node.");

        const srcs = Array.isArray(src) ? src : [src];
        const deep = options.deep === true || (options.deep !== false && (node.type as string) === 'translation_unit');

        const allMatches: any[] = [];
        const seenIds = new Set<number | string>();

        for (const s of srcs) {
            const matches = this.matcher.matchAll(node as any, s, deep);
            for (const m of matches) {
                const syntaxNode = m.node as any;
                if (syntaxNode && !seenIds.has(syntaxNode.id)) {
                    const matchNode = node.tree.wrap(syntaxNode) as SourceNode<CNodeTypes> | null;
                    if (matchNode) {
                        const captures: Record<string, any> = {};
                        for (const key in m) {
                            if (key !== 'node' && m[key]) {
                                const val = m[key] as any;
                                if (Array.isArray(val)) {
                                    captures[key] = val.map(n => node.tree.wrap(n)).filter(Boolean);
                                } else if (val && typeof val.id !== 'undefined') {
                                    const wrapped = node.tree.wrap(val);
                                    if (wrapped) captures[key] = wrapped;
                                } else {
                                    captures[key] = val;
                                }
                            }
                        }
                        allMatches.push({ node: matchNode, captures: captures });
                        seenIds.add(syntaxNode.id);
                    }
                }
            }
        }

        if (callback) {
            return allMatches.map(m => callback({ ...m.captures, node: m.node } as any));
        }
        return allMatches;
    }

    /**
     * Registers a transformation for nodes matching a pattern.
     * @param {SourceNode<any>} node - Root node to search within.
     * @param {string | string[]} src - Pattern.
     * @param {function(Record<string, any>, SourceNode<CNodeTypes>, UppHelpersC): any} callback - Transformation logic.
     * @param {any} [options] - Optional settings.
     */
    withPatternAndCaptures(node: SourceNode<any>, src: string | string[], callback: (captures: Record<string, any>, target: SourceNode<CNodeTypes>, helpers: UppHelpersC) => any, options: any = {}): void {
        const matches = this.matchAll(node, src, undefined, options);
        for (const match of matches) {
            this.withNode(match.node, (target, helpers) => callback(match.captures, target as SourceNode<CNodeTypes>, helpers as UppHelpersC));
        }
    }

    /**
     * Replaces all matches of a pattern.
     * @param {SourceNode<CNodeTypes>} node - Scope.
     * @param {string} src - Pattern.
     * @param {function(any): string | null | undefined} callback - Replacement callback.
     * @param {any} [options] - Options.
     */
    matchReplace(node: SourceNode<CNodeTypes>, src: string, callback: (match: { node: SourceNode<CNodeTypes>, captures: Record<string, SourceNode<CNodeTypes>> }) => string | null | undefined, options: { deep?: boolean } = {}): void {
        const matches = this.matchAll(node, src, undefined, { ...options, deep: true });
        for (const m of matches) {
            // Automatic recursion avoidance
            const key = (this as any).transformKey + "::" + src;
            if ((this as any).transformKey) {
                if ((this.registry as any).visit(key, m.node)) {
                    const result = callback({ ...m.captures, node: m.node } as any);
                    if (result !== undefined) {
                        this.replace(m.node, result === null ? "" : result);
                    }
                }
            } else {
                const result = callback({ ...m.captures, node: m.node } as any);
                if (result !== undefined) {
                    this.replace(m.node, result === null ? "" : result);
                }
            }
        }
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
     * @returns {string} The C type string (e.g. "char *").
     */
    getType(node: SourceNode<CNodeTypes> | string | null): string {
        if (!node) return "";
        const target = typeof node === 'string' ? this.findDefinition(node) : node;
        if (!target) return "";

        let declNode: SourceNode<CNodeTypes> | null = target;
        let idNode: SourceNode<CNodeTypes> | null = (target.type === 'identifier' || target.type === 'type_identifier') ? target : null;

        if (!idNode) {
            while (declNode &&
                declNode.type !== 'declaration' &&
                declNode.type !== 'parameter_declaration' &&
                declNode.type !== 'field_declaration' &&
                declNode.type !== 'type_definition' &&
                declNode.type !== 'function_definition' &&
                declNode.type !== 'struct_specifier' &&
                declNode.type !== 'union_specifier' &&
                declNode.type !== 'enum_specifier') {
                declNode = declNode.parent as SourceNode<CNodeTypes> | null;
            }
            if (!declNode) return "";
            const ids = declNode.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier');
            // Prioritize the actual identifier over type_identifier to get pointer/array info correctly
            idNode = ids.find(n => n.type === 'identifier' || n.type === 'field_identifier') || ids[0] || null;
        } else {
            while (declNode &&
                declNode.type !== 'declaration' &&
                declNode.type !== 'parameter_declaration' &&
                declNode.type !== 'field_declaration' &&
                declNode.type !== 'type_definition' &&
                declNode.type !== 'function_definition' &&
                declNode.type !== 'struct_specifier' &&
                declNode.type !== 'union_specifier' &&
                declNode.type !== 'enum_specifier') {
                declNode = declNode.parent as SourceNode<CNodeTypes> | null;
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

        let typeNode = declNode.childForFieldName('type');
        if (!typeNode) {
            typeNode = declNode.children.find(c =>
                ['primitive_type', 'type_identifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(c.type as string)
            ) || null;
            if (!typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type as string)) {
                typeNode = declNode;
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

        return result.trim();
    }

    /**
     * Returns the number of array dimensions wrapping an identifier.
     * @param {SourceNode<CNodeTypes>} defNode - The definition node.
     * @returns {number} Array depth.
     */
    getArrayDepth(defNode: SourceNode<CNodeTypes>): number {
        if (!defNode) return 0;
        let depth = 0;
        let p: SourceNode<CNodeTypes> | null = defNode;
        while (p) {
            if (p.type === 'array_declarator') depth++;
            if (['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition'].includes(p.type as string)) break;
            p = p.parent as SourceNode<CNodeTypes> | null;
        }
        return depth;
    }

    /**
     * Determines the lexical scope node for a given identifier.
     * @param {SourceNode<any>} node - The identifier node.
     * @returns {SourceNode<CNodeTypes>|null} The scope node.
     */
    getEnclosingScope(node: SourceNode<any>): SourceNode<CNodeTypes> | null {
        if (!node) return null;
        let p = node.parent as SourceNode<CNodeTypes> | null;
        while (p) {
            if (['compound_statement', 'translation_unit', 'field_declaration_list', 'enumerator_list'].includes(p.type as string)) {
                return p;
            }
            if (p.type === 'function_definition') {
                const sig = this.getFunctionSignature(p);
                if (sig.nameNode && (sig.nameNode === node || this.isDescendant(sig.nameNode, node))) {
                    p = p.parent as SourceNode<CNodeTypes> | null;
                    continue;
                }
                return p;
            }
            p = p.parent as SourceNode<CNodeTypes> | null;
        }
        return null;
    }

    /**
     * Extracts function signature details.
     * @param {SourceNode<CNodeTypes>} fnNode - The function_definition node.
     * @returns {any} Signature details.
     */
    getFunctionSignature(fnNode: SourceNode<CNodeTypes>): any {
        if (!fnNode) return { returnType: "void", name: "unknown", params: "()" };

        let typeNode = fnNode.childForFieldName('type');
        if (!typeNode) {
            typeNode = fnNode.children.find(c => (c.type as string).includes('type_specifier') || c.type === 'primitive_type') || null;
        }
        const returnType = typeNode ? typeNode.text : "void";

        let declarator = fnNode.childForFieldName('declarator');
        if (!declarator) {
            declarator = fnNode.children.find(c => c.type !== 'compound_statement' && c !== typeNode) || null;
        }

        let funcDecl = declarator as SourceNode<CNodeTypes> | null;
        while (funcDecl && (funcDecl.type === 'pointer_declarator' || funcDecl.type === 'parenthesized_declarator')) {
            funcDecl = funcDecl.childForFieldName('declarator') as SourceNode<CNodeTypes> | null || funcDecl.children.find(c => (c.type as string).includes('declarator')) as SourceNode<CNodeTypes> | null || null;
        }

        const nameNode = funcDecl ? (funcDecl.childForFieldName('declarator') || funcDecl.children[0]) : null;
        const name = nameNode ? nameNode.text : "unknown";

        const paramList = funcDecl ? (funcDecl.childForFieldName('parameters') || funcDecl.children.find(c => c.type === 'parameter_list')) : null;
        const params = paramList ? paramList.text : "()";

        let bodyNode = fnNode.childForFieldName('body') || fnNode.children.find(c => c.type === 'compound_statement');

        return { returnType, name, params, bodyNode, node: fnNode, nameNode };
    }

    /**
     * Finds the definition for a node or name.
     * @param {SourceNode<any>|string} target - The identifier node, a container node with a single identifier, or a scoping node (if name is provided).
     * @param {string|any} [nameOrOptions] - The name to find (if target is a scope) or options object.
     * @param {any} [options] - Resolution options { variable: true, tag: true }.
     * @returns {SourceNode<CNodeTypes>|null} The declaration/definition node.
     */
    findDefinitionOrNull(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> | null {
        try {
            return this.findDefinition(target, nameOrOptions, options);
        } catch (ex) {
            return null;
        }
    }

    /**
     * Finds the definition for a node or name.
     * @param {SourceNode<any>|string} target - The identifier node, a container node with a single identifier, or a scoping node (if name is provided).
     * @param {string|any} [nameOrOptions] - The name to find (if target is a scope) or options object.
     * @param {any} [options] - Resolution options { variable: true, tag: true }.
     * @returns {SourceNode<CNodeTypes>} The declaration/definition node.
     */
    findDefinition(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> {
        let name: string | null = null;
        let startScope: SourceNode<any> | null = null;
        let finalOptions = (typeof nameOrOptions === 'object' && nameOrOptions !== null) ? { ...options, ...nameOrOptions } : options;

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
            }
        }

        if (!name || !startScope) throw new Error("helpers.findDefinition: no valid identifier or scope found");

        const findInScope = (scope: SourceNode<any>) => {
            return scope.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'type_identifier').filter((idNode: SourceNode<CNodeTypes>) => {
                return this.getEnclosingScope(idNode) === (scope as SourceNode<CNodeTypes>);
            });
        };

        let current: SourceNode<any> | null = startScope;
        while (current) {
            const identifiers = findInScope(current);

            for (const idNode of identifiers) {
                if ((idNode as any).searchableText === name) {
                    let p: SourceNode<any> | null = idNode;
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
                                return p as SourceNode<CNodeTypes>;
                            }
                            break;
                        }
                        if (p.type === 'parameter_declaration' || p.type === 'declaration' || p.type === 'type_definition' || p.type === 'field_declaration' || p.type === 'function_definition') {
                            if (isDeclarator || (idNode.parent === p && idNode.fieldName !== 'type')) {
                                if (finalOptions.variable) return p as SourceNode<CNodeTypes>;
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
        if (!node || node.type === 'identifier' || node.type === 'type_identifier') {
            throw new Error(`findReferences: Expected declaration/definition node, found ${node ? node.type : 'null'}`);
        }

        const idInDef = node.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier')[0];
        const name = idInDef ? idInDef.text : node.text;
        if (!name) throw new Error("helpers.findReferences: Invalid node");

        const root = this.findRoot();
        if (!root) throw new Error("helpers.findReferences: Invalid root");
        const ids = root.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier');

        const refs: SourceNode<CNodeTypes>[] = [];
        for (const idNode of ids) {
            if (idNode.text === name) {
                if (idInDef && idNode === idInDef) continue;
                const def = this.findDefinitionOrNull(idNode);
                if (def && def === node) {
                    refs.push(idNode);
                }
            }
        }
        return refs;
    }

    /**
     * Transforms references to a definition intelligently.
     * @param {SourceNode<CNodeTypes>} definitionNode - The definition node.
     * @param {function(SourceNode, UppHelpersC): string|null|undefined} callback - Transformation callback.
     */
    withReferences(definitionNode: SourceNode<CNodeTypes>, callback: (n: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
        if (!definitionNode || definitionNode.type === 'identifier' || definitionNode.type === 'type_identifier') {
            throw new Error(`withReferences: Expected declaration/definition node, found ${definitionNode ? definitionNode.type : 'null'}`);
        }

        const idInDef = definitionNode.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier')[0];
        if (!idInDef) {
            throw new Error("withReferences: Could not find identifier in definition node");
        }
        const originalName = idInDef.text;

        const rule: TransformRule<CNodeTypes> = {
            active: true,
            matcher: (node: SourceNode<CNodeTypes>, helpers: any) => {
                const cHelpers = helpers as UppHelpersC;
                if (node.type !== 'identifier' && node.type !== 'field_identifier') return false;
                if (node.text !== originalName) return false;
                const def = cHelpers.findDefinitionOrNull(node);
                // Compare by index/type since node objects might not be stable across major parses
                return !!(def && def.startIndex === definitionNode.startIndex && def.type === definitionNode.type);
            },
            callback: (node: SourceNode<CNodeTypes>, helpers: any) => callback(node, helpers as UppHelpersC)
        };

        this.registry.registerTransformRule(rule as any);

        // Immediate sweep for already-parsed or out-of-order nodes
        this.atRoot((root, helpers) => {
            const refs = this.findReferences(definitionNode);
            const cHelpers = helpers as UppHelpersC;
            for (const ref of refs) {
                const result = callback(ref, cHelpers);
                if (result !== undefined) {
                    cHelpers.replace(ref, result === null ? '' : result);
                }
            }
        });
    }

    /**
     * Finds and transforms a definition node intelligently.
     * @param {SourceNode<any>|string} target - The node or name.
     * @param {function(SourceNode, UppHelpersC): string|null|undefined} callback - Transformation callback.
     */
    withDefinition(target: SourceNode<any> | string, callback: (n: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
        const defNode = this.findDefinitionOrNull(target);
        if (!defNode) return;
        this.withNode(defNode, (node, helpers) => callback(node as SourceNode<CNodeTypes>, helpers as UppHelpersC));
    }

    /**
     * Transforms nodes matching a pattern intelligently.
     * @param {CNodeTypes} nodeType - The node type to match.
     * @param {function(SourceNode, UppHelpersC): boolean} matcher - Custom matcher function.
     * @param {function(SourceNode, UppHelpersC): string|null|undefined} callback - Transformation callback.
     */
    withPattern(nodeType: CNodeTypes, matcher: (node: SourceNode<CNodeTypes>, helpers: UppHelpersC) => boolean, callback: (node: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
        const rule: TransformRule<CNodeTypes> = {
            active: true,
            matcher: (node: SourceNode<CNodeTypes>, helpers: any) => {
                const cHelpers = helpers as UppHelpersC;
                if (node.type !== nodeType) return false;
                return matcher(node, cHelpers);
            },
            callback: (node: SourceNode<CNodeTypes>, helpers: any) => callback(node, helpers as UppHelpersC)
        };

        this.registry.registerTransformRule(rule as any);

        this.atRoot((root, helpers) => {
            helpers.walk(root, (node) => {
                const cNode = node as SourceNode<CNodeTypes>;
                if (cNode.type === nodeType) {
                    const cHelpers = helpers as UppHelpersC;
                    if (matcher(cNode, cHelpers)) {
                        const replacement = callback(cNode, cHelpers);
                        if (replacement !== undefined) {
                            cHelpers.replace(cNode, replacement === null ? '' : replacement);
                        }
                    }
                }
            });
        });
    }

    /**
     * Transforms nodes matching a source fragment pattern.
     * @param {SourceNode<any>} scope - The search scope.
     * @param {string} pattern - The source fragment pattern.
     * @param {function(any, UppHelpersC): (string|null|undefined)} callback - Transformation callback.
     */
    withMatch(scope: SourceNode<any>, pattern: string, callback: (captures: Record<string, SourceNode<CNodeTypes>>, helpers: UppHelpersC) => string | null | undefined): void {
        this.matchAll(scope, pattern, (match) => {
            if (match && match.node) {
                this.withNode(match.node, ((_node: SourceNode<any>, helpers: any) => callback(match as any, helpers as UppHelpersC)) as any);
            }
        });
    }

    /**
     * Determines how an array should be expanded based on its C/UPP parent context.
     * @param {any[]} values The values to expand.
     * @param {CNodeTypes} parentType The tree-sitter node type of the parent.
     * @returns {any[]} The expanded list of nodes/text.
     */
    protected override getArrayExpansion(values: any[], parentType: CNodeTypes): any[] {
        const result: any[] = [];
        const isStatementBlock = (parentType as string) === 'compound_statement' || (parentType as string) === 'translation_unit';
        const isList = (parentType as string) === 'parameter_list' || (parentType as string) === 'argument_list' || (parentType as string) === 'initializer_list';

        let first = true;
        for (const val of values) {
            if (!first) {
                if (isStatementBlock) result.push('\n');
                else if (isList) result.push(', ');
                else result.push(' ');
            }
            first = false;
            result.push(val);
            if (isStatementBlock) result.push(';');
        }
        return result;
    }
}

export { UppHelpersC };
