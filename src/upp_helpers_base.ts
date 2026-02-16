import { SourceNode, SourceTree } from './source_tree.ts';
import type { Invocation, Registry, RegistryContext } from './registry.ts';

let uniqueIdCounter = 1;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase<LanguageNodeTypes extends string> {
    public root: SourceNode<LanguageNodeTypes> | null;
    public registry: Registry;
    public _parentHelpers: UppHelpersBase<LanguageNodeTypes> | null;
    public contextNode: SourceNode<LanguageNodeTypes> | null;
    public invocation: Invocation | null;
    public lastConsumedNode: SourceNode<LanguageNodeTypes> | null;
    public isDeferred: boolean;
    public currentInvocations: Invocation[];
    public consumedIds: Set<number | string>;
    public context: RegistryContext | null;
    public parentTree: SourceNode<any> | null;
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
        this.parentTree = (registry && registry.parentRegistry && registry.parentRegistry.tree) ? registry.parentRegistry.tree.root : null;
        this.stdPath = registry ? registry.stdPath : null;
    }


    code(strings: TemplateStringsArray, ...values: any[]): SourceNode<LanguageNodeTypes> {
        let text = "";
        const nodeMap = new Map<string, SourceNode>();
        const listMap = new Map<string, any[]>();
        const usedNodes = new Map<SourceNode, string>();

        const processValue = (val: any, index: number) => {
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
            } else if (typeof val !== 'string' && typeof val[Symbol.iterator] === 'function') {
                // Unified Array Placeholder: use a single placeholder for the entire list
                const placeholder = this.createUniqueIdentifier('__UPP_NODE_STABILITY_l');
                listMap.set(placeholder, Array.from(val));
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

        const prepared = (this.registry as any).prepareSource(text, (this.registry as any).originPath);
        let cleanText = prepared.cleanSource;

        const SourceTree: any = this.registry.tree!.constructor;
        const fragment = SourceTree.fragment(cleanText, this.registry.language);
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
                        const expansion = this.getArrayExpansion(originalValue, parentType);
                        pNode.replaceWith(expansion);
                    } else {
                        const nodeToInsert = originalValue as SourceNode;
                        nodeToInsert.remove();
                        pNode.replaceWith(nodeToInsert);
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
    protected getArrayExpansion(values: any[], parentType: string): any[] {
        const result: any[] = [];
        let first = true;
        for (const val of values) {
            if (!first) result.push('\n');
            first = false;
            result.push(val);
        }
        return result;
    }

    atRoot(callback: (root: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): string {
        const root = this.findRoot();
        if (!root) return "";
        return this.withNode(root, callback);
    }

    withScope(callback: (scope: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): string {
        const scope = this.findScope();
        if (!scope) return "";
        return this.withNode(scope, callback);
    }

    withRoot(callback: (root: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): string {
        return this.withNode(this.findRoot()!, callback);
    }

    /**
     * @deprecated Use code or withPattern instead.
     */
    registerTransform(callback: (root: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): string {
        return this.atRoot(callback);
    }

    registerTransformRule(rule: any): void {
        this.registry.registerTransformRule(rule);
    }

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

    insertBefore(n: SourceNode<LanguageNodeTypes>, content: string | SourceNode<any> | SourceNode<any>[] | SourceTree<any>): SourceNode<LanguageNodeTypes> | SourceNode<LanguageNodeTypes>[] {
        if (!n || !n.insertBefore) throw new Error(`Illegal call to helpers.insertBefore(node, content).`);
        return n.insertBefore(content as any) as any;
    }

    insertAfter(n: SourceNode<LanguageNodeTypes>, content: string | SourceNode<any> | SourceNode<any>[] | SourceTree<any>): SourceNode<LanguageNodeTypes> | SourceNode<LanguageNodeTypes>[] {
        if (!n || !n.insertAfter) throw new Error(`Illegal call to helpers.insertAfter(node, content).`);
        return n.insertAfter(content as any) as any;
    }

    findRoot(): SourceNode<LanguageNodeTypes> | null {
        return (this.context && this.context.tree) ? this.context.tree.root : this.root;
    }



    withNode(node: SourceNode<LanguageNodeTypes> | null, callback: (target: SourceNode<LanguageNodeTypes>, helpers: UppHelpersBase<LanguageNodeTypes>) => any): string {
        if (!node) return "";
        node.markers.push({
            callback: (target: SourceNode<any>, helpers: UppHelpersBase<any>) => callback(target as any, helpers as any),
            data: {}
        });
        return "";
    }

    wrapNode(node: SourceNode<any>): SourceNode<any> {
        return node; // No longer needed, but kept for compatibility during transition
    }

    /**
     * Finds macro invocations in the tree.
     * @param {string} macroName
     * @param {SourceNode<LanguageNodeTypes>} [node]
     * @returns {any[]}
     */
    findInvocations(macroName: string, node: SourceNode<LanguageNodeTypes> | null = null): Invocation[] {
        let target = node || this.root;
        if (!target && this.registry) {
            target = this.registry.tree ? this.registry.tree.root : null as any;
        }

        if (!target) {
            const source = (this.registry as any).source || (this.context && this.context.tree && this.context.tree.source);
            if (!source) return [];

            const invs = (this.registry as any).findInvocations(source);
            return invs.filter((i: Invocation) => i.name === macroName).map((i: Invocation) => ({
                ...i,
                text: `@${i.name}(${i.args.join(',')})`,
                // Mock includes for package.hup
                includes: (str: string) => i.args.some((arg: string) => arg.includes(str))
            }));
        }

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

    isDescendant(parent: SourceNode<any> | null, node: SourceNode<any>): boolean {
        let current: any = node;
        const rawParent: any = parent ? (parent as any).__internal_raw_node || parent : null;
        while (current) {
            const rawCurrent = current.__internal_raw_node || current;
            if (rawCurrent === rawParent) return true;
            current = rawCurrent.parent;
        }
        return false;
    }

    walk(node: SourceNode<any>, callback: (n: SourceNode<any>) => void): void {
        if (!node) return;
        callback(node);
        const rawNode = (node as any).__internal_raw_node || node;
        const lateBound = !!(node as any).__isLateBound; // We might need to track this
        const sourceOverride = (node as any).__sourceOverride; // And this

        for (let i = 0; i < rawNode.childCount; i++) {
            this.walk((this as any).wrapNode(rawNode.child(i), lateBound, sourceOverride), callback);
        }
    }


    parent(node: SourceNode<any>): SourceNode<any> | null {
        return node ? node.parent : null;
    }

    childForFieldName(node: SourceNode<any> | null, fieldName: string): SourceNode<any> | null {
        if (!node) return null;
        return node.findChildByFieldName(fieldName);
    }

    findNextNodeAfter(root: SourceNode<LanguageNodeTypes> | null, index: number): SourceNode<LanguageNodeTypes> | null {
        if (!root) return null;

        const findNextSibling = (node: SourceNode<any>): SourceNode<any> | null => {
            if (!node || !node.parent || node === root) return null;
            const idx = node.parent.children.indexOf(node);
            if (idx === -1) return null;
            for (let i = idx + 1; i < node.parent.children.length; i++) {
                const sibling = node.parent.children[i];
                if (sibling.startIndex >= index) return sibling;
            }
            return findNextSibling(node.parent);
        };

        let current: SourceNode<any> | null = root.descendantForIndex(index, index);

        while (current && current.startIndex < index && current.endIndex > index && current.children.length > 0) {
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

        while (current && current.endIndex <= index) {
            current = findNextSibling(current);
        }

        if (!current || current === root) return null;

        while (current.children.length > 0) {
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
            while (p) {
                if (p === root) { ok = true; break; }
                p = p.parent;
            }
            if (!ok) return null;
        }

        return isSafe ? current as SourceNode<LanguageNodeTypes> : null;
    }


    findScope(): SourceNode<LanguageNodeTypes> | null {
        const startNode = (this.lastConsumedNode && this.lastConsumedNode.parent) ? this.lastConsumedNode : this.contextNode;
        return this.findEnclosing(startNode!, (['compound_statement', 'translation_unit'] as any) as LanguageNodeTypes[]);
    }

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

    createUniqueIdentifier(prefix: string = 'v'): string {
        const id = uniqueIdCounter++;
        return `${prefix}_${id}`;
    }

    childCount(node: SourceNode<any> | null): number {
        return node ? node.childCount : 0;
    }

    child(node: SourceNode<any> | null, index: number): SourceNode<any> | null {
        return node ? node.child(index) : null;
    }

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
