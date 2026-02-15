import { SourceNode, SourceTree } from './source_tree.ts';
import type { Invocation, Registry, RegistryContext } from './registry.ts';

let uniqueIdCounter = 1;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    public root: SourceNode | null;
    public registry: Registry;
    public _parentHelpers: UppHelpersBase | null;
    public contextNode: SourceNode | null;
    public invocation: Invocation | null;
    public lastConsumedNode: SourceNode | null;
    public isDeferred: boolean;
    public currentInvocations: Invocation[];
    public consumedIds: Set<number | string>;
    public context: RegistryContext | null;
    public parentTree: SourceNode | null;
    public stdPath: string | null;
    public lastConsumedIndex?: number;
    public parentRegistry?: {
        invocations: Invocation[];
        sourceCode: string;
        helpers: UppHelpersBase;
    };
    public topLevelInvocation?: Invocation | null;

    get parentHelpers(): UppHelpersBase | null { return this._parentHelpers; }
    set parentHelpers(v: UppHelpersBase | null) { this._parentHelpers = v; }

    get isAuthoritative(): boolean { return this.registry.isAuthoritative; }
    set isAuthoritative(v: boolean) { this.registry.isAuthoritative = v; }

    constructor(root: SourceNode | null, registry: Registry, parentHelpers: UppHelpersBase | null = null) {
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


    code(strings: TemplateStringsArray, ...values: any[]): SourceNode {
        let text = "";
        const nodeMap = new Map<string, SourceNode>();
        const usedNodes = new Map<SourceNode, string>();

        const processValue = (val: any, index: number) => {
            if (val instanceof SourceNode) {
                if (!val.isValid) {
                    const nodeInfo = val.type ? `type: ${val.type}` : "unknown type";
                    console.warn(`[UPP WARNING] Macro substitution uses a stale node reference (${nodeInfo}). It may have been destroyed by a previous non-identity-preserving transformation. Falling back to text-only interpolation.`);
                    text += val.text;
                    return;
                }
                if (usedNodes.has(val)) {
                    // If we've already used this node, reuse the placeholder
                    // so the same node reference is used multiple times
                    // Note: this turns the tree into a cyclic graph
                    const placeholder = usedNodes.get(val);
                    text += placeholder;
                } else {
                    const placeholder = `__UPP_NODE_STABILITY_${this.createUniqueIdentifier('p')}`;
                    usedNodes.set(val, placeholder);
                    nodeMap.set(placeholder, val);
                    text += placeholder;
                }
            } else if (val === null || val === undefined) {
                throw new Error(`upp.code: Invalid null or undefined value at index ${index}`);
            } else if (typeof val !== 'string' && typeof val[Symbol.iterator] === 'function') {
                let first = true;
                for (const item of val) {
                    if (!first) text += '\n';
                    first = false;
                    processValue(item, index);
                }
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
        const placeholders = Array.from(nodeMap.keys());
        for (const placeholder of placeholders) {
            const placeholderNodes = fragment.find((n: SourceNode) => n.text === placeholder);
            if (placeholderNodes.length === 0) {
                // This might happen if the placeholder was somehow mangled or in a comment (though unlikely with our naming)
                throw new Error(`upp.code: Placeholder ${placeholder} not found in parsed fragment`);
            }

            const originalNode = nodeMap.get(placeholder)!;
            originalNode.remove();

            // Replace placeholder with original node
            for (const pNode of placeholderNodes) {
                pNode.replaceWith(originalNode);
            }
        }

        return fragment;
    }

    atRoot(callback: (root: SourceNode, helpers: UppHelpersBase) => any): string {
        const root = this.findRoot();
        if (!root) return "";
        return this.withNode(root, callback);
    }

    withScope(callback: (scope: SourceNode, helpers: UppHelpersBase) => any): string {
        const scope = this.findScope();
        if (!scope) return "";
        return this.withNode(scope, callback);
    }

    withRoot(callback: (root: SourceNode, helpers: UppHelpersBase) => any): string {
        return this.withNode(this.findRoot()!, callback);
    }

    /**
     * @deprecated Use code or withPattern instead.
     */
    registerTransform(callback: (root: SourceNode, helpers: UppHelpersBase) => any): string {
        return this.atRoot(callback);
    }

    registerTransformRule(rule: any): void {
        this.registry.registerTransformRule(rule);
    }

    replace(n: SourceNode, newContent: string | SourceNode | SourceNode[] | SourceTree | null): SourceNode | SourceNode[] | null {
        let finalContent = newContent;
        if (typeof finalContent === 'string' && finalContent.includes('@') && this.registry && (this.registry as any).prepareSource) {
            const prepared = (this.registry as any).prepareSource(finalContent, (this.registry as any).originPath);
            finalContent = prepared.cleanSource;
        }

        if (n.replaceWith) {
            const result = n.replaceWith(finalContent as any);
            if (this.contextNode === n) this.contextNode = result as any;
            return result;
        }

        throw new Error(`Illegal call to helpers.replace(node, content).`);
    }

    insertBefore(n: SourceNode, content: string | SourceNode | SourceNode[] | SourceTree): SourceNode | SourceNode[] {
        if (!n || !n.insertBefore) throw new Error(`Illegal call to helpers.insertBefore(node, content).`);
        return n.insertBefore(content as any);
    }

    insertAfter(n: SourceNode, content: string | SourceNode | SourceNode[] | SourceTree): SourceNode | SourceNode[] {
        if (!n || !n.insertAfter) throw new Error(`Illegal call to helpers.insertAfter(node, content).`);
        return n.insertAfter(content as any);
    }

    findRoot(): SourceNode | null {
        return (this.context && this.context.tree) ? this.context.tree.root : this.root;
    }



    withNode(node: SourceNode | null, callback: (target: SourceNode, helpers: UppHelpersBase) => any): string {
        if (!node) return "";
        node.markers.push({
            callback: (target: SourceNode, helpers: UppHelpersBase) => callback(target, helpers),
            data: {}
        });
        return "";
    }

    wrapNode(node: SourceNode): SourceNode {
        return node; // No longer needed, but kept for compatibility during transition
    }

    /**
     * Finds macro invocations in the tree.
     * @param {string} macroName
     * @param {SourceNode} [node]
     * @returns {any[]}
     */
    findInvocations(macroName: string, node: SourceNode | null = null): Invocation[] {
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
    public _getNextNode(expectedTypes: string[] | null = null): SourceNode | null {
        const root = this.root || this.findRoot();
        const index = this.lastConsumedIndex || (this.invocation && this.invocation.invocationNode?.endIndex);
        if (index === undefined || index === null) return null;
        return this.findNextNodeAfter(root, index);
    }

    /**
     * Retrieves the next node without removing it from the tree.
     * @param {string|string[] | null} [types] 
     * @returns {SourceNode|null}
     */
    nextNode(types: string | string[] | null = null): SourceNode | null {
        const expectedTypes = typeof types === 'string' ? [types] : types;
        const node = this._getNextNode(expectedTypes);
        if (node && expectedTypes && !expectedTypes.includes(node.type)) {
            return null;
        }
        return node;
    }

    consume(expectedTypeOrOptions?: string | string[] | { type?: string | string[], message?: string, validate?: (n: SourceNode) => boolean }, errorMessage?: string): SourceNode | null {
        let expectedTypes: string[] | null = null;
        let internalErrorMessage = errorMessage;
        let validateFn: ((n: SourceNode) => boolean) | null = null;

        if (typeof expectedTypeOrOptions === 'string') expectedTypes = [expectedTypeOrOptions];
        else if (Array.isArray(expectedTypeOrOptions)) expectedTypes = expectedTypeOrOptions;
        else if (expectedTypeOrOptions && typeof expectedTypeOrOptions === 'object') {
            expectedTypes = Array.isArray(expectedTypeOrOptions.type) ? expectedTypeOrOptions.type : (expectedTypeOrOptions.type ? [expectedTypeOrOptions.type] : null);
            internalErrorMessage = (expectedTypeOrOptions as any).message || errorMessage;
            validateFn = (expectedTypeOrOptions as any).validate;
        }

        const reportFailure = (foundNode: SourceNode | null) => {
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

        const captureText = (n: SourceNode) => {
            n._capturedText = n.text;
            n.children.forEach(captureText);
        };
        captureText(node);
        const wrapped = node;

        const nextSearchIndex = node.startIndex;

        if (!isHoisted) {
            node.remove();
        }

        this.consumedIds.add(node.id);
        this.lastConsumedNode = node;
        this.lastConsumedIndex = nextSearchIndex;
        return wrapped;
    }

    isDescendant(parent: SourceNode | null, node: SourceNode): boolean {
        let current: any = node;
        const rawParent: any = parent ? (parent as any).__internal_raw_node || parent : null;
        while (current) {
            const rawCurrent = current.__internal_raw_node || current;
            if (rawCurrent === rawParent) return true;
            current = rawCurrent.parent;
        }
        return false;
    }

    walk(node: SourceNode, callback: (n: SourceNode) => void): void {
        if (!node) return;
        callback(node);
        const rawNode = (node as any).__internal_raw_node || node;
        const lateBound = !!(node as any).__isLateBound; // We might need to track this
        const sourceOverride = (node as any).__sourceOverride; // And this

        for (let i = 0; i < rawNode.childCount; i++) {
            this.walk((this as any).wrapNode(rawNode.child(i), lateBound, sourceOverride), callback);
        }
    }


    parent(node: SourceNode): SourceNode | null {
        return node ? node.parent : null;
    }

    childForFieldName(node: SourceNode | null, fieldName: string): SourceNode | null {
        if (!node) return null;
        return node.findChildByFieldName(fieldName);
    }

    findNextNodeAfter(root: SourceNode | null, index: number): SourceNode | null {
        if (!root) return null;

        const findNextSibling = (node: SourceNode): SourceNode | null => {
            if (!node || !node.parent || node === root) return null;
            const idx = node.parent.children.indexOf(node);
            if (idx === -1) return null;
            for (let i = idx + 1; i < node.parent.children.length; i++) {
                const sibling = node.parent.children[i];
                if (sibling.startIndex >= index) return sibling;
            }
            return findNextSibling(node.parent);
        };

        let current: SourceNode | null = root.descendantForIndex(index, index);

        while (current && current.startIndex < index && current.endIndex > index && current.children.length > 0) {
            let nextChild: SourceNode | null = null;
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
            if (current.startIndex >= index && current.isNamed) break;

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

        return isSafe ? current : null;
    }


    findScope(): SourceNode | null {
        const startNode = (this.lastConsumedNode && this.lastConsumedNode.parent) ? this.lastConsumedNode : this.contextNode;
        return this.findEnclosing(startNode!, ['compound_statement', 'translation_unit']);
    }

    findEnclosing(node: SourceNode, types: string | string[]): SourceNode | null {
        if (!node) return null;
        const typeArray = Array.isArray(types) ? types : [types];
        let p = node.parent;
        while (p) {
            if (typeArray.includes(p.type)) return p;
            p = p.parent;
        }
        return null;
    }

    createUniqueIdentifier(prefix: string = 'v'): string {
        const id = uniqueIdCounter++;
        return `${prefix}_${id}`;
    }

    childCount(node: SourceNode | null): number {
        return node ? node.childCount : 0;
    }

    child(node: SourceNode | null, index: number): SourceNode | null {
        return node ? node.child(index) : null;
    }

    error(node: SourceNode | string, message?: string): never {
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
