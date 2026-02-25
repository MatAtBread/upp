import { SourceNode, SourceTree } from './source_tree.ts';
import type { Invocation, Registry, RegistryContext, TransformRule } from './registry.ts';
import { PatternMatcher } from './pattern_matcher.ts';
import Parser from 'tree-sitter';
import type { MacroResult, AnySourceNode, AnySourceTree, InterpolationValue } from './types.ts';

let uniqueIdCounter = 1;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
abstract class UppHelpersBase<LanguageNodeTypes extends string> {
    public root: SourceNode<LanguageNodeTypes> | null;
    public registry: Registry;
    public matcher: PatternMatcher;
    public _parentHelpers: UppHelpersBase<LanguageNodeTypes> | null;
    public contextNode: SourceNode<LanguageNodeTypes> | null;
    public invocation: Invocation | null;
    public lastConsumedNode: SourceNode<LanguageNodeTypes> | null;
    public isDeferred: boolean;
    public currentInvocations: Invocation[];
    public consumedIds: Set<number | string>;
    public context: RegistryContext | null;

    public stdPath: string | null;
    public lastConsumedIndex?: number;
    public parentRegistry?: {
        invocations: Invocation[];
        sourceCode: string;
        helpers: UppHelpersBase<LanguageNodeTypes>;
    };
    public topLevelInvocation?: Invocation | null;

    get parentHelpers(): UppHelpersBase<LanguageNodeTypes> | null { return this._parentHelpers; }
    set parentHelpers(v: UppHelpersBase<LanguageNodeTypes> | null) { this._parentHelpers = v; }

    get isAuthoritative(): boolean { return this.registry.isAuthoritative; }
    set isAuthoritative(v: boolean) { this.registry.isAuthoritative = v; }

    constructor(root: SourceNode<LanguageNodeTypes> | null, registry: Registry, parentHelpers: UppHelpersBase<LanguageNodeTypes> | null = null) {
        this.root = root;
        this.registry = registry;
        this._parentHelpers = parentHelpers;
        this.contextNode = null;
        this.invocation = null;
        this.lastConsumedNode = null;
        this.isDeferred = false;
        this.currentInvocations = [];
        this.consumedIds = new Set();
        this.context = null; // Back-reference to the local transform context

        this.stdPath = registry ? registry.stdPath : null;

        // Use a dedicated parser for patterns to avoid invalidating the main registry parser/tree
        const patternParser = new Parser();
        if (registry && registry.language) {
            patternParser.setLanguage(registry.language as any);
        }
        this.matcher = new PatternMatcher((src) => patternParser.parse(src), registry ? registry.language as any : null);
    }


    code(strings: TemplateStringsArray, ...values: InterpolationValue[]): SourceNode<LanguageNodeTypes> {
        let text = "";
        const nodeMap = new Map<string, SourceNode>();
        const listMap = new Map<string, any[]>();
        const usedNodes = new Map<SourceNode, string>();

        const processValue = (val: InterpolationValue, index: number) => {
            if (val instanceof SourceNode) {
                if (!val.isValid) {
                    const nodeInfo = val.type ? `type: ${val.type}` : "unknown type";
                    text += `\n/* [UPP WARNING] Macro substitution uses a stale node reference (${nodeInfo}). It may have been destroyed by a previous non-identity-preserving transformation. Falling back to text-only interpolation. */\n`;
                    text += val.text;
                    return;
                }
                if (usedNodes.has(val)) {
                    text += `\n/* [UPP WARNING] Macro substitution uses a node reference (type: ${val.type}) more than once. Falling back to text-only interpolation. */\n`;
                    text += val.text;
                    return;

                } else {
                    const placeholder = this.createUniqueIdentifier('__UPP_NODE_STABILITY_p');
                    usedNodes.set(val, placeholder);
                    nodeMap.set(placeholder, val);
                    text += placeholder;
                }
            } else if (val === null || val === undefined) {
                throw new Error(`upp.code: Invalid null or undefined value at index ${index}`);
            } else if (Array.isArray(val)) {
                // Unified Array Placeholder: use a single placeholder for the entire list
                const placeholder = this.createUniqueIdentifier('__UPP_NODE_STABILITY_l');
                listMap.set(placeholder, val);
                text += placeholder;
            } else {
                text += String(val);
            }
        };

        for (let i = 0; i < strings.length; i++) {
            text += strings[i];
            if (i < values.length) {
                processValue(values[i], i);
            }
        }

        const prepared = this.registry.prepareSource(text, this.registry.originPath || "");
        let cleanText = prepared.cleanSource;

        // @ts-ignore - reaching into internals for tree cloning
        const SourceTreeCtor: any = this.registry.tree!.constructor;
        const fragment = SourceTreeCtor.fragment(cleanText, this.registry.language);
        if (!fragment) {
            throw new Error("upp.code: Failed to parse code fragment");
        }

        // Walk and replace placeholders with actual nodes
        const processReplacement = (pMap: Map<string, any>, isList: boolean) => {
            const keys = Array.from(pMap.keys());
            for (const placeholder of keys) {
                let placeholderNodes = fragment.find((n: SourceNode) => n.text === placeholder);
                if (placeholderNodes.length === 0) {
                    // Fallback: search for mangled placeholders (inside other tokens or comments)
                    const mangledNodes = fragment.find((n: SourceNode) => n.text.indexOf(placeholder) !== -1);
                    if (mangledNodes.length > 0) {
                        const originalValue = pMap.get(placeholder);
                        const replacementText = Array.isArray(originalValue)
                            ? originalValue.map(v => (v instanceof SourceNode ? v.text : String(v))).join('')
                            : (originalValue instanceof SourceNode ? originalValue.text : String(originalValue));

                        for (const mNode of mangledNodes) {
                            if (!mNode.isValid) continue;
                            mNode.text = mNode.text.split(placeholder).join(replacementText);
                        }
                    }
                    continue;
                }

                // Filter to only leaf-most nodes matching the placeholder to avoid redundant replacements
                // (e.g. if a declaration only contains the placeholder, both the declaration and identifier match)
                placeholderNodes = placeholderNodes.filter((n: SourceNode) =>
                    !n.children.some(c => fragment.find((child: SourceNode) => child.id === c.id && child.text === placeholder).length > 0)
                );

                // Re-fetch nodes after filtering and sort by start index descending to avoid offset issues
                placeholderNodes.sort((a: SourceNode, b: SourceNode) => b.startIndex - a.startIndex);

                const originalValue = pMap.get(placeholder)!;
                for (const pNode of placeholderNodes) {
                    if (!pNode.isValid) continue;

                    if (isList) {
                        const parentType = pNode.parent ? pNode.parent.type : 'root';
                        const values = (originalValue as any[]).map(v => {
                            if (v instanceof SourceNode && v.tree !== fragment.tree) {
                                v.remove();
                                return v;
                            }
                            return v;
                        });
                        const expansion = this.getArrayExpansion(values, parentType);
                        pNode.replaceWith(expansion);
                    } else {
                        let nodeToInsert = originalValue as SourceNode;
                        // To preserve referential stability, we always remove the node so it interpolates correctly.
                        // We only remove if it's not already in our target fragment tree (avoiding redundant removals in duplication cases).
                        if (nodeToInsert instanceof SourceNode && nodeToInsert.tree !== fragment.tree) {
                            nodeToInsert.remove();
                        }
                        pNode.replaceWith(nodeToInsert, false);
                    }
                }
            }
        };

        processReplacement(nodeMap, false);
        processReplacement(listMap, true);

        return fragment;
    }

    /**
     * Determines how an array should be expanded based on its parent context.
     * @param {any[]} values The values to expand.
     * @param {string} parentType The tree-sitter node type of the parent.
     * @returns {any[]} The expanded list of nodes/text.
     */
    protected getArrayExpansion(values: InterpolationValue[], parentType: string): InterpolationValue[] {
        const result: InterpolationValue[] = [];
        let first = true;
        for (const val of values) {
            if (!first) result.push('\n');
            first = false;
            result.push(val);
        }
        return result;
    }

    /**
     * Executes a callback within the context of the root node.
     * @param {function(SourceNode<LanguageNodeTypes>, UppHelpersBase<LanguageNodeTypes>): any} callback - The callback to execute.
     * @returns {string} Always empty string (transformations happen via markers).
     */
    withRoot(callback: (root: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): void {
        const root = this.findRoot();
        if (!root) throw new Error("upp.withRoot: No root node found.");
        this.withNode(root, callback);
    }

    /**
     * Executes a callback within the context of the current scope.
     * @param {function(SourceNode<LanguageNodeTypes>, UppHelpersBase<LanguageNodeTypes>): any} callback - The callback to execute.
     * @returns {string} Always empty string.
     */
    withScope(callback: (scope: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): void {
        const scope = this.findScope();
        if (!scope) return;
        this.withNode(scope, callback);
    }

    /**
     * Replaces a node with new content.
     * @param {SourceNode<LanguageNodeTypes>} n - The node to replace.
     * @param {string | SourceNode<any> | SourceNode<any>[] | SourceTree<any> | null} newContent - The replacement content.
     * @returns {SourceNode<LanguageNodeTypes> | SourceNode<LanguageNodeTypes>[] | null} The new node(s) or null.
     */
    replace(n: SourceNode<LanguageNodeTypes>, newContent: string | SourceNode<any> | SourceNode<any>[] | SourceTree<any> | null): SourceNode<LanguageNodeTypes> | SourceNode<LanguageNodeTypes>[] | null {
        let finalContent = newContent;
        if (typeof finalContent === 'string' && finalContent.includes('@') && this.registry && (this.registry as any).prepareSource) {
            const prepared = (this.registry as any).prepareSource(finalContent, (this.registry as any).originPath);
            finalContent = prepared.cleanSource;
        }


        if (n.replaceWith) {
            const result = n.replaceWith(finalContent as any);
            if (this.contextNode === n) this.contextNode = result as any;
            return result as any;
        }

        throw new Error(`Illegal call to helpers.replace(node, content).`);
    }

    /**
     * Finds the root node of the current context or the main tree.
     * @returns {SourceNode<LanguageNodeTypes> | null} The root node.
     */
    findRoot(): SourceNode<LanguageNodeTypes> | null {
        return (this.context && this.context.tree) ? this.context.tree.root : this.root;
    }

    /**
     * Attaches a marker to a node for late-bound transformation.
     * @param {SourceNode<LanguageNodeTypes> | null} node - The target node.
     * @param {function(SourceNode<LanguageNodeTypes>, UppHelpersBase<LanguageNodeTypes>): any} callback - The transformation callback.
     * @returns {string} Always empty string.
     */
    withNode(node: SourceNode<LanguageNodeTypes> | null, callback: (target: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): void {
        if (!node) return;

        const targetNode = node;
        this.registry.registerPendingRule({
            contextNode: this.findRoot()!,
            matcher: (n) => n === targetNode,
            callback: (n, h) => callback(n as SourceNode<LanguageNodeTypes>, h as UppHelpersBase<LanguageNodeTypes>)
        });
    }

    /**
    * Performs a one-off structural match against a specific node.
    * Unlike find(), match() uses code patterns and can extract sub-nodes into captures.
    * Use this for immediate inspection or to "peek" into a node's structure.
    * 
    * @param {AnySourceNode} node - Target node to match against.
    * @param {string | string[]} src - Pattern(s) to match. Can include $wildcards.
    * @param {function(captures: Record<string, AnySourceNode>): any} [callback] - Function called with captures if match succeeds.
    * @param {{ deep?: boolean }} [options] - Match options (e.g., deep search).
    * @returns {any} Result of callback, captures object, or null.
    */
    match(node: AnySourceNode, src: string | string[], callback?: (captures: Record<string, AnySourceNode>) => any, options: { deep?: boolean } = {}): any {
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
     * Finds all structural matches of a pattern within a scope.
     * Unlike find(), this matches against complex code templates rather than just node types.
     * 
     * @param {AnySourceNode} node - Search scope.
     * @param {string | string[]} src - Pattern(s) to match.
     * @param {{ deep?: boolean }} [options] - Options (deep search is often enabled by default).
     * @returns {{ node: SourceNode<LanguageNodeTypes>, captures: Record<string, AnySourceNode> }[]} List of matches (node + captures).
     */
    matchAll(node: AnySourceNode, src: string | string[], options: { deep?: boolean } = {}): { node: SourceNode<LanguageNodeTypes>, captures: Record<string, AnySourceNode> }[] {
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
                    const matchNode = node.tree.wrap(syntaxNode) as SourceNode<LanguageNodeTypes> | null;
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

        return allMatches;
    }

    /**
    * Synchronously replaces all matches of a pattern within a scope.
    * Replacements happen immediately during macro execution. 
    * Contrast with withMatch(), which defers transformations until later.
    * 
    * @param {SourceNode<LanguageNodeTypes>} node - Search scope.
    * @param {string} src - Pattern to match.
    * @param {function(match: { node: SourceNode<LanguageNodeTypes>, captures: Record<string, SourceNode<LanguageNodeTypes>> }): string | null | undefined} callback - Returns replacement text or node.
    * @param {{ deep?: boolean }} [options] - Options.
    */
    matchReplace(node: SourceNode<LanguageNodeTypes>, src: string, callback: (match: { node: SourceNode<LanguageNodeTypes>, captures: Record<string, SourceNode<LanguageNodeTypes>> }) => string | null | undefined, options: { deep?: boolean } = {}): void {
        const matches = this.matchAll(node, src, { ...options, deep: true });
        for (const m of matches) {
            const result = callback({ ...m.captures, node: m.node } as any);
            if (result !== undefined) {
                this.replace(m.node, result === null ? "" : result);
            }
        }
    }

    /**
    * Registers a marker for deferred transformation of nodes matching a pattern.
    * The callback is executed later by the registry, ensuring the node is in its
    * final state after other macros have executed. This is the safest way to
    * perform cross-cutting or global transformations.
    * 
    * @param {AnySourceNode} scope - The search scope.
    * @param {string} pattern - The source fragment pattern.
    * @param {function(Record<string, AnySourceNode>, UppHelpersBase<LanguageNodeTypes>, AnySourceNode): MacroResult} callback - Deferred transformation callback.
    */
    withMatch(scope: AnySourceNode, pattern: string | string[], callback: (captures: Record<string, AnySourceNode>, helpers: UppHelpersBase<LanguageNodeTypes>, node: AnySourceNode) => MacroResult): void {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        this.registry.registerPendingRule({
            contextNode: scope as SourceNode<any>,
            matcher: (n, h) => {
                // If scope is a root node (translation_unit), match globally
                // This allows header-registered rules to apply to the main file
                const isRootScope = (scope as SourceNode<any>).type === 'translation_unit';
                if (!isRootScope && !h.isDescendant(scope as SourceNode<any>, n)) return false;
                // Live structural match - check any of the patterns
                return patterns.some(p => !!h.match(n, p));
            },
            callback: (n, h) => {
                // Find which pattern matched
                for (const p of patterns) {
                    const m = h.match(n, p);
                    if (m) return callback(m, h as UppHelpersBase<LanguageNodeTypes>, n);
                }
                return undefined;
            }
        });
    }

    /**
    * Registers a marker for intelligent, pattern-based transformation of a specific node type.
    * Unlike withMatch(), which uses source code fragments, withPattern() matches against 
    * specific AST node types and uses a custom matcher function for filtering.
    * 
    * @param {LanguageNodeTypes} nodeType - The node type to match (e.g., 'call_expression').
    * @param {function(SourceNode<LanguageNodeTypes>, UppHelpersBase<LanguageNodeTypes>): boolean} matcher - Custom filter function.
    * @param {function(SourceNode<LanguageNodeTypes>, UppHelpersBase<LanguageNodeTypes>): MacroResult} callback - Deferred transformation callback.
    */
    withPattern(nodeType: LanguageNodeTypes, matcher: (node: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => boolean, callback: (node: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => MacroResult): void {
        const rule: TransformRule<LanguageNodeTypes> = {
            active: true,
            matcher: (node: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<any>) => {
                if (node.type !== nodeType) return false;
                return matcher(node, helpers as UppHelpersBase<LanguageNodeTypes>);
            },
            callback: (node: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<any>) => callback(node, helpers as UppHelpersBase<LanguageNodeTypes>)
        };

        this.registry.registerTransformRule(rule);

        this.withRoot((root: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => {
            helpers.walk(root, (node: SourceNode<any>) => {
                if (node.type === nodeType) {
                    if (matcher(node as SourceNode<LanguageNodeTypes>, helpers)) {
                        const replacement = callback(node as SourceNode<LanguageNodeTypes>, helpers);
                        if (replacement !== undefined) {
                            helpers.replace(node as SourceNode<LanguageNodeTypes>, replacement === null ? '' : replacement);
                        }
                    }
                }
            });
        });
    }

    /**
     * Finds macro invocations in the tree.
     * @param {string} macroName - Name of the macro (without @).
     * @param {SourceNode<LanguageNodeTypes>} [node] - Search scope.
     * @returns {Invocation[]} List of invocations found.
     */
    findInvocations(macroName: string, node: SourceNode<LanguageNodeTypes> | null = null): Invocation[] {
        const target = node || this.root || (this.registry?.tree?.root ?? null);
        if (!target) return [];

        const pattern = new RegExp(`@${macroName}\\s*\\(`);
        const results = target.find((n: SourceNode) => {
            if (n.type === 'preproc_def') return pattern.test(n.text);
            if (n.type === 'comment') {
                return n.text.startsWith('/*@') && pattern.test(n.text);
            }
            return false;
        });
        return results as any;
    }


    /**
     * Loads a dependency file into the registry.
     * @param {string} file - The file path to load.
     */
    loadDependency(file: string): void {
        this.registry.loadDependency(file, this.context?.originPath || 'unknown', this as any);
    }


    /**
     * Finds the next logical node after the macro invocation.
     * @private
     */
    public _getNextNode(expectedTypes: string[] | null = null): SourceNode<LanguageNodeTypes> | null {
        const root = this.root || this.findRoot();
        const index = this.lastConsumedIndex || (this.invocation && this.invocation.invocationNode?.endIndex);
        if (index === undefined || index === null) return null;
        return this.findNextNodeAfter(root, index);
    }

    /**
     * Retrieves the next node without removing it from the tree.
     * @param {K|K[] | null} [types] 
     * @returns {SourceNode<K>|null}
     */
    nextNode<K extends LanguageNodeTypes>(types: K | K[] | null = null): SourceNode<K> | null {
        const expectedTypes = (typeof types === 'string' ? [types] : types) as string[] | null;
        const node = this._getNextNode(expectedTypes);
        if (node && expectedTypes && !expectedTypes.includes(node.type)) {
            return null;
        }
        return node as SourceNode<K> | null;
    }

    /**
     * Consumes the next logical node after the macro invocation.
     * @param {K | K[] | { type?: K | K[], message?: string, validate?: (n: SourceNode<LanguageNodeTypes>) => boolean }} [expectedTypeOrOptions] - Expected node type(s) or options.
     * @param {string} [errorMessage] - Custom error message if consumption fails.
     * @returns {SourceNode<K> | null} The consumed node or null.
     */
    consume<K extends LanguageNodeTypes>(expectedTypeOrOptions?: K | K[] | { type?: K | K[], message?: string, validate?: (n: SourceNode<LanguageNodeTypes>) => boolean }, errorMessage?: string): SourceNode<K> | null {
        let expectedTypes: string[] | null = null;
        let internalErrorMessage = errorMessage;
        let validateFn: ((n: SourceNode<LanguageNodeTypes>) => boolean) | null = null;

        if (typeof expectedTypeOrOptions === 'string') expectedTypes = [expectedTypeOrOptions];
        else if (Array.isArray(expectedTypeOrOptions)) expectedTypes = expectedTypeOrOptions as string[];
        else if (expectedTypeOrOptions && typeof expectedTypeOrOptions === 'object') {
            expectedTypes = (Array.isArray(expectedTypeOrOptions.type) ? expectedTypeOrOptions.type : (expectedTypeOrOptions.type ? [expectedTypeOrOptions.type] : null)) as string[] | null;
            internalErrorMessage = (expectedTypeOrOptions as any).message || errorMessage;
            validateFn = (expectedTypeOrOptions as any).validate;
        }

        const reportFailure = (foundNode: SourceNode<LanguageNodeTypes> | null) => {
            const macroName = this.invocation ? `@${this.invocation.name}` : "macro";
            let msg = internalErrorMessage;
            if (!msg) {
                const expectedStr = expectedTypes ? expectedTypes.join(' or ') : 'an additional code block';
                const foundStr = foundNode ? `found ${foundNode.type}` : 'nothing found';
                msg = `${macroName} expected ${expectedStr}, but ${foundStr}`;
            }
            this.error(foundNode || (this.invocation && this.invocation.invocationNode) || this.contextNode!, msg!);
        };

        const node = this._getNextNode(expectedTypes);

        if (!node) {
            if (expectedTypes || validateFn) reportFailure(null);
            return null;
        }

        if (expectedTypes && !expectedTypes.includes(node.type)) reportFailure(node);
        if (validateFn && !validateFn(node)) reportFailure(node);

        const isHoisted = this.invocation?.invocationNode && this.isDescendant(node, this.invocation.invocationNode);

        const captureText = (n: SourceNode<any>) => {
            n._capturedText = n.text;
            n.children.forEach(captureText);
        };
        captureText(node);
        const wrapped = node as SourceNode<K>;

        const nextSearchIndex = node.startIndex;

        if (!isHoisted) {
            node.remove();
        }

        this.consumedIds.add(node.id);
        this.lastConsumedNode = node;
        this.lastConsumedIndex = nextSearchIndex;
        return wrapped;
    }

    /**
     * Checks if a node is a descendant of another node.
     * @param {SourceNode<any> | null} parent - Potential parent node.
     * @param {SourceNode<any>} node - Target node to check.
     * @returns {boolean} True if descendant, false otherwise.
     */
    isDescendant(parent: SourceNode<any> | null, node: SourceNode<any>): boolean {
        let current: any = node;
        const rawParent: any = parent ? (parent as any).__internal_raw_node || parent : null;
        const visited = new Set<any>();
        while (current) {
            if (visited.has(current)) break;
            visited.add(current);
            const rawCurrent = current.__internal_raw_node || current;
            if (rawCurrent === rawParent) return true;
            // Support traversal through detached parent if real parent is null
            current = rawCurrent.parent || rawCurrent._detachedParent;
        }
        return false;
    }

    /**
     * Recursively walks the AST starting from a node and executes a callback.
     * @param {SourceNode<any>} node - Start node.
     * @param {function(SourceNode<any>): void} callback - The callback to execute for each node.
     */
    walk(node: SourceNode<any>, callback: (n: SourceNode<any>) => void): void {
        const stack: SourceNode<any>[] = [node];
        const visited = new Set<SourceNode<any>>();
        let counter = 0;
        while (stack.length > 0) {
            counter++;
            if (counter > 50000) {
                console.error(`Infinite loop in walk() detected! Node type: ${stack[stack.length - 1]?.type}, text: ${stack[stack.length - 1]?.text}`);
                throw new Error("Infinite loop in walk()");
            }
            const current = stack.pop();
            if (!current || visited.has(current)) continue;
            visited.add(current);
            callback(current);
            // Snapshot children to prevent cycles/issues if modified during walk
            const children = [...current.children];
            for (let i = children.length - 1; i >= 0; i--) {
                const child = children[i];
                if (child) stack.push(child);
            }
        }
    }

    /**
     * Finds the next logical node after a specific index.
     * @param {SourceNode<LanguageNodeTypes> | null} root - The search root.
     * @param {number} index - The start index.
     * @returns {SourceNode<LanguageNodeTypes> | null} The next node or null.
     */
    findNextNodeAfter(root: SourceNode<LanguageNodeTypes> | null, index: number): SourceNode<LanguageNodeTypes> | null {
        if (!root) return null;

        const visitedSibling = new Set<SourceNode<any>>();
        const findNextSibling = (node: SourceNode<any>): SourceNode<any> | null => {
            if (!node || !node.parent || node === root) return null;
            if (visitedSibling.has(node)) return null;
            visitedSibling.add(node);

            const idx = node.parent.children.indexOf(node);
            if (idx === -1) return null;
            for (let i = idx + 1; i < node.parent.children.length; i++) {
                const sibling = node.parent.children[i];
                if (sibling.startIndex >= index) return sibling;
            }
            return findNextSibling(node.parent);
        };

        let current: SourceNode<any> | null = root.descendantForIndex(index, index);
        const visitedWrap = new Set<SourceNode<any>>();

        while (current && current.startIndex < index && current.endIndex > index && current.children.length > 0) {
            if (visitedWrap.has(current)) break;
            visitedWrap.add(current);
            let nextChild: SourceNode<any> | null = null;
            for (const child of current.children) {
                if (child.endIndex > index) {
                    nextChild = child;
                    break;
                }
            }
            if (nextChild) current = nextChild;
            else break;
        }

        let loopLimit = 0;
        while (current && current.endIndex <= index) {
            loopLimit++;
            if (loopLimit > 1000) {
                console.warn("[upp] findNextNodeAfter: primary sibling loop limit reached!");
                break;
            }
            current = findNextSibling(current);
        }

        if (!current || current === root) return null;

        const visitedDeep = new Set<SourceNode<any>>();
        loopLimit = 0;
        while (current.children.length > 0) {
            loopLimit++;
            if (loopLimit > 1000) break;
            if (visitedDeep.has(current)) break;
            visitedDeep.add(current);
            if (current.startIndex >= index && (current as any).isNamed) break;

            let found = false;
            for (const child of current.children) {
                if (child.startIndex >= index) {
                    current = child;
                    found = true;
                    break;
                } else if (child.endIndex > index) {
                    current = child;
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }

        const isSafe = (current && current.startIndex >= index && current !== root);
        if (isSafe) {
            let p = current.parent;
            let ok = false;
            const visitedParent = new Set<SourceNode<any>>();
            while (p) {
                if (visitedParent.has(p)) break;
                visitedParent.add(p);
                if (p === root) { ok = true; break; }
                p = p.parent;
            }
            if (!ok) return null;
        }

        return isSafe ? current as SourceNode<LanguageNodeTypes> : null;
    }


    abstract findScope(): SourceNode<LanguageNodeTypes> | null;

    /**
     * Finds the nearest enclosing node of a given type.
     * @param {SourceNode<any>} node - Start node.
     * @param {K | K[]} types - Target node type(s).
     * @returns {SourceNode<K> | null} The enclosing node or null.
     */
    findEnclosing<K extends LanguageNodeTypes>(node: SourceNode<any>, types: K | K[]): SourceNode<K> | null {
        if (!node) return null;
        const typeArray = (Array.isArray(types) ? types : [types]) as string[];
        let p = node.parent;
        while (p) {
            if (typeArray.includes(p.type)) return p as SourceNode<K>;
            p = p.parent;
        }
        return null;
    }

    /**
     * Creates a unique identifier with the given prefix.
     * @param {string} [prefix='v'] - The prefix to use.
     * @returns {string} The unique identifier.
     */
    createUniqueIdentifier(prefix: string = 'v'): string {
        const id = uniqueIdCounter++;
        return `${prefix}_${id}`;
    }

    /**
     * Throws an UPP error and associates it with a node.
     * @param {SourceNode<any> | string} node - The node associated with the error or the message.
     * @param {string} [message] - The error message.
     * @returns {never}
     */
    error(node: SourceNode<any> | string, message?: string): never {
        let finalNode: any = node;
        let finalMessage = message;

        if (arguments.length === 1 && typeof node === 'string') {
            finalMessage = node;
            finalNode = this.contextNode || (this.invocation && this.invocation.invocationNode);
        }

        const err: any = new Error(finalMessage);
        err.isUppError = true;
        err.node = finalNode;
        throw err;
    }
}

export { UppHelpersBase };
