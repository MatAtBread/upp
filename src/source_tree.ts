import Parser from 'tree-sitter';
import type { Tree, SyntaxNode } from 'tree-sitter';

import type { Language } from './types.ts';

/**
 * Represents a source file as a manageable tree of nodes, 
 * providing an API for live source code manipulation.
 */
export class SourceTree<NodeTypes extends string = string> {
    public source: string;
    public language: Language;
    public parser: Parser;
    public tree: Tree;
    public nodeCache: Map<number | string, SourceNode<NodeTypes>>;
    public root: SourceNode<NodeTypes>;
    public onMutation: (() => void) | null = null;

    /**
     * @param {string} source Initial source code text.
     * @param {Language} language Tree-sitter Language object.
     */
    constructor(source: string, language: Language) { // language is tree-sitter Language
        if (typeof source !== 'string') {
            throw new Error(`SourceTree expects string source, got ${typeof source}`);
        }
        this.source = source;
        this.language = language;
        this.parser = new Parser();
        this.parser.setLanguage(language);

        // Initial parse
        try {
            this.tree = this.parser.parse((index: number) => {
                if (index >= source.length) return null;
                return source.slice(index, index + 4096);
            });
        } catch (e) {
            throw e;
        }

        /** @type {Map<string, SourceNode>} Map of TreeSitterNode.id -> SourceNode */
        this.nodeCache = new Map();

        /** @type {SourceNode} The root node of the tree. */
        this.root = this.wrap(this.tree.rootNode) as SourceNode<NodeTypes>;
    }

    /**
     * Internal method to get or create a SourceNode wrapper for a Tree-sitter node.
     * @param {SyntaxNode | null} tsNode The Tree-sitter node to wrap.
     * @param {SourceNode | null} [parent] The parent SourceNode, if any.
     * @param {string | null} [fieldName] The field name for this node in the parent.
     * @returns {SourceNode|null}
     */
    wrap<T extends NodeTypes>(tsNode: SyntaxNode | null, parent: SourceNode<NodeTypes> | null = null, fieldName: string | null = null): SourceNode<T> | null {
        if (!tsNode) return null;
        if (this.nodeCache.has(tsNode.id)) {
            const node = this.nodeCache.get(tsNode.id)! as SourceNode<T>;
            if (parent) node.parent = parent;
            if (fieldName) node.fieldName = fieldName;
            return node;
        }

        const node = new SourceNode(this, tsNode, parent, fieldName) as SourceNode<T>;
        this.nodeCache.set(tsNode.id, node);
        return node;
    }

    /**
     * Apply a specialized splice to the source string and update tracking for all active nodes.
     * @param {number} start The start index of the edit.
     * @param {number} end The end index of the edit.
     * @param {string} newText The replacement text.
     */
    edit(start: number, end: number, newText: string): void {
        const oldLen = end - start;
        const newLen = newText.length;
        const delta = newLen - oldLen;

        // 1. Update source string
        this.source = this.source.slice(0, start) + newText + this.source.slice(end);

        // 2. Notify active nodes to shift their offsets
        const nodes = Array.from(this.nodeCache.values());
        for (const node of nodes) {
            node.handleEdit(start, end, delta);
        }

        if (this.onMutation) this.onMutation();
    }

    // Node Interface Methods (Delegated to Root)

    /** @returns {number} */
    get startIndex(): number { return 0; }
    /** @returns {number} */
    get endIndex(): number { return this.source.length; }
    /** @returns {string} */
    get type(): string { return 'fragment'; }
    /** @returns {SourceNode<any>[]} */
    get children(): SourceNode<NodeTypes>[] { return this.root.children; }
    /** @returns {string} */
    get text(): string { return this.source; }
    /** @param {string} val */
    set text(val: string) { this.edit(0, this.source.length, val); }

    /**
     * Creates a SourceNode from a code fragment.
     * Tries to parse as valid code; if it fails, wraps in a dummy function to parse statements/expressions.
     * @param {string | SourceNode<any> | SourceTree<any>} code The text fragment to parse.
     * @param {Language} language Tree-sitter language object.
     * @returns {SourceNode<NodeTypes>}
     */
    static fragment<NodeTypes extends string = string>(code: string | SourceNode<any> | SourceTree<any>, language: Language): SourceNode<NodeTypes> {
        if (typeof code !== 'string') {
            if (code instanceof SourceNode) return code;
            if (code instanceof SourceTree) return code.root;
            throw new Error('SourceTree.fragment: Invalid parameter');
        }

        const trimmed = code.trim();
        // Special case: If it's a single valid identifier, parse it as such to avoid statement wrappers/errors
        const idRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        const keywords = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'break', 'continue', 'void', 'int', 'char', 'float', 'double', 'struct', 'union', 'enum', 'typedef', 'static', 'extern', 'const', 'volatile', 'inline'];
        if (idRegex.test(trimmed) && !keywords.includes(trimmed)) {
            const dummy = `void* __tmp = (void*)${trimmed};`;
            const fragTree = new SourceTree(dummy, language);
            // We want the identifier that matches our text, not the dummy '__tmp'
            const idNode = fragTree.root.find(n => (n.type === 'identifier' || n.type === 'type_identifier') && n.text === trimmed)[0];
            if (idNode) {
                // Return the identifier node directly. It will be migrated during attachment.
                return idNode as SourceNode<NodeTypes>;
            }
        }

        const parser = new Parser();
        parser.setLanguage(language);
        let tree = parser.parse((index: number) => {
            if (index >= code.length) return null;
            return code.slice(index, index + 4096);
        });

        let hasError = false;
        if (typeof tree.rootNode.hasError === 'function') {
            hasError = (tree.rootNode as any).hasError();
        } else {
            hasError = tree.rootNode.toString().includes("ERROR");
        }

        if (!hasError) {
            const root = tree.rootNode;
            let isTopLevel = true;

            for (let i = 0; i < root.childCount; i++) {
                const child = root.child(i);
                if (child) {
                    const type = child.type;
                    if (!['function_definition', 'declaration', 'preproc_def', 'preproc_include', 'preproc_ifdef', 'type_definition'].includes(type)) {
                        isTopLevel = false;
                        break;
                    }
                }
            }

            if (isTopLevel && root.childCount > 0) {
                return new SourceTree(code, language).root as SourceNode<NodeTypes>;
            }
        }

        // 2. Try wrapping in a function (for statements/expressions)
        const wrappedCode = `void __frag() { ${code} }`;
        const wrappedTree = new SourceTree(wrappedCode, language);

        const funcDef = wrappedTree.root.children.find(c => c.type === 'function_definition');
        if (!funcDef) throw new Error("Failed to parse wrapped fragment.");

        const body = funcDef.children.find(c => c.type === 'compound_statement');
        if (!body) throw new Error("Failed to parse wrapped fragment body.");

        const innerNodes = body.children.slice(1, -1);

        if (innerNodes.length === 0) {
            return new SourceTree("", language).root as SourceNode<NodeTypes>;
        }

        if (innerNodes.length === 1) {
            // Return just the single node, but it must be migrated to its own tree to be independent
            const node = innerNodes[0];
            const text = node.text;
            const fragTree = new SourceTree(text, language);
            // Return the first child of the translation_unit (the actual node)
            return fragTree.root.children[0] || fragTree.root as SourceNode<NodeTypes>;
        }

        // Multiple nodes? Create a new SourceTree with just those nodes' text.
        const combinedText = innerNodes.map(n => n.text).join('\n');
        const finalTree = new SourceTree(combinedText, language);
        return finalTree.root as SourceNode<NodeTypes>;
    }

    /**
     * Serializes the tree to JSON, avoiding circular references.
     * @returns {Object}
     */
    toJSON(): { source: string, root: any } {
        return {
            source: this.source,
            root: this.root
        };
    }

    /**
     * Merges current tree's nodes into another target SourceTree.
     * @param {SourceTree} targetTree The tree to merge into.
     * @param {number} offset The offset to apply to all migrated nodes.
     */
    mergeInto(targetTree: SourceTree<NodeTypes>, offset: number): void {
        // 1. Transfer all cached nodes
        for (const [id, node] of this.nodeCache) {
            // Update node to point to new tree
            node.tree = targetTree;
            // Shift offsets
            node.startIndex += offset;
            node.endIndex += offset;
            // Register in target
            targetTree.nodeCache.set(id, node);
        }

        // 2. Clear our cache (we are now empty/invalid logic wise, but nodes are safe)
        this.nodeCache.clear();
    }
}

/**
 * Represents a node within a SourceTree.
 */
export class SourceNode<T extends string = string> {
    public tree: SourceTree<any>;
    public id: number | string;
    public type: T;
    public startIndex: number;
    public endIndex: number;
    public children: SourceNode<any>[];
    public parent: SourceNode<any> | null;
    public fieldName: string | null;

    public data: Record<string, unknown>;
    public _capturedText?: string;
    public _snapshotSearchable?: string;
    public _detachedParent?: SourceNode<any> | null;
    public _detachedIndex?: number;

    /**
     * @param {SourceTree<any>} tree The tree this node belongs to.
     * @param {SyntaxNode} tsNode The Tree-sitter node to wrap.
     * @param {SourceNode<any> | null} [parent] The parent SourceNode, if any.
     * @param {string | null} [fieldName] The field name for this node in the parent.
     */
    constructor(tree: SourceTree<any>, tsNode: SyntaxNode, parent: SourceNode<any> | null = null, fieldName: string | null = null) {
        if (!tsNode || !tree) {
            throw new Error("SourceNode must be created with a Tree-sitter node.");
        }
        this.tree = tree;
        this.id = tsNode.id;
        this.type = tsNode.type as T;
        this.startIndex = tsNode.startIndex;
        this.endIndex = tsNode.endIndex;
        this.children = [];
        this.parent = parent;
        this.fieldName = fieldName;
        for (let i = 0; i < tsNode.childCount; i++) {
            const child = tsNode.child(i);
            const childFieldName = tsNode.fieldNameForChild(i);
            const wrapped = tree.wrap(child, this, childFieldName);
            if (wrapped) {
                this.children.push(wrapped);
            }
        }


        this.data = {};
    }

    /** @returns {boolean} */
    get isNamed(): boolean {
        return this.type !== undefined && this.type !== null && !/^[^a-zA-Z_]/.test(this.type);
    }

    /** @returns {boolean} */
    get isValid(): boolean {
        return this.startIndex !== -1 &&
            this.tree &&
            this.tree.nodeCache &&
            this.tree.nodeCache.get(this.id) === this;
    }

    /** @returns {SourceNode<any>|null} */
    get nextNamedSibling(): SourceNode<any> | null {
        if (!this.parent) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx + 1; i < this.parent.children.length; i++) {
            const child = this.parent.children[i];
            if (child.isNamed) return child;
        }
        return null;
    }

    /** @returns {SourceNode<any>|null} */
    get prevNamedSibling(): SourceNode<any> | null {
        if (!this.parent) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx - 1; i >= 0; i--) {
            const child = this.parent.children[i];
            if (child.isNamed) return child;
        }
        return null;
    }

    /** @returns {number} */
    get namedChildCount(): number {
        return this.children.filter(c => c.isNamed).length;
    }

    /** 
     * @param {number} idx 
     * @returns {SourceNode<any>|null} 
     */
    namedChild(idx: number): SourceNode<any> | null {
        const named = this.children.filter(c => c.isNamed);
        return named[idx] || null;
    }

    /** @returns {SourceNode<any>|null} */
    get firstNamedChild(): SourceNode<any> | null {
        return this.namedChild(0);
    }

    toString(): string {
        return this.text;
    }

    /** @returns {string} */
    get text(): string {
        if (this.startIndex === -1) return "";
        return this.tree.source.slice(this.startIndex, this.endIndex);
    }

    /** 
     * Returns the name to use for symbol resolution. 
     * Prioritizes _capturedText to allow resolution by original name after a rename.
     * @returns {string} 
     */
    get searchableText(): string {
        if (this._capturedText !== undefined) return this._capturedText.trim();
        return this.text.trim();
    }

    /** @param {string} value */
    set text(value: string) {
        this.replaceWith(value);
    }

    /** @returns {number} */
    get childCount(): number {
        return this.children.length;
    }

    /**
     * Returns an object mapping named children to their nodes.
     * Proxied for concise access (e.g., node.named.fieldName).
     * @returns {Record<string, SourceNode<any> | undefined>}
     */
    get named(): Record<string, SourceNode<any> | undefined> {
        return Object.fromEntries(this.children.filter(c => c.isNamed).map((c, idx) => [c.fieldName ?? idx, c]));
    }
    /**
     * @returns {Object}
     */
    toJSON(): Object {
        return {
            id: this.id,
            type: this.type,
            fieldName: this.fieldName,
            startIndex: this.startIndex,
            endIndex: this.endIndex,
            text: this.text,
            children: this.children.map(c => c.toJSON()),
            named: this.named
        };
    }

    /** 
     * @param {number} idx 
     * @returns {SourceNode<any>} 
     */
    child(idx: number): SourceNode<any> {
        return this.children[idx];
    }

    /**
     * Internal method called by SourceTree when a global edit happens.
     * @param {number} editStart The start index of the edit.
     * @param {number} editEnd The end index of the edit.
     * @param {number} delta Offset change duration.
     */
    handleEdit(editStart: number, editEnd: number, delta: number): void {
        if (this.startIndex === -1) return;


        // Case: Edit completely contains this node. Invalidate.
        if (editStart <= this.startIndex && editEnd >= this.endIndex) {
            this._invalidateRecursively();
            return;
        }

        // Case 1: Edit is completely AFTER this node. No change.
        if (this.endIndex <= editStart) return;

        // Case 2: Edit is completely BEFORE this node. Shift both.
        if (this.startIndex >= editEnd) {
            this.startIndex += delta;
            this.endIndex += delta;
            return;
        }

        // Case 3: Edit is INSIDE this node (or overlaps).
        // This node expands/contracts to contain the edit.
        this.endIndex += delta;
    }

    // --- DOM API ---

    /**
     * Removes the node from the tree and returns the removed sub-tree.
     * @returns {SourceTree<any>}
     */
    remove(): SourceTree<any> {
        this._detachedParent = this.parent;
        if (this.parent) {
            this._detachedIndex = this.parent.children.indexOf(this);
        }
        // 1. Snapshot current text range.
        const cachedText = this.text;

        // 2. Create new holding tree with text.
        const newTree = new SourceTree<any>(cachedText, this.tree.language);

        // 3. Migrate `this` node into newTree at offset 0.
        const oldStartIndex = this.startIndex;
        const oldEndIndex = this.endIndex;
        const oldTree = this.tree;

        // Recursive migration function
        const migrate = (n: SourceNode<any>, offsetDelta: number) => {
            // Remove from old tree
            if (n.tree) n.tree.nodeCache.delete(n.id);

            // Add to new tree
            n.tree = newTree;
            n.startIndex += offsetDelta;
            n.endIndex += offsetDelta;
            newTree.nodeCache.set(n.id, n);

            n.children.forEach(c => migrate(c, offsetDelta));
        };

        // Delta: oldStart -> 0. delta = -oldStart.
        migrate(this, -oldStartIndex);

        // 4. Clean up parent reference in old tree
        if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx > -1) this.parent.children.splice(idx, 1);
        }
        this.parent = null;

        // 5. Delete text from old tree
        oldTree.edit(oldStartIndex, oldEndIndex, "");

        return newTree;
    }

    /**
     * Recursively invalidates this node and its children, 
     * removing them from the tree cache.
     * @private
     */
    public _invalidateRecursively(): void {
        this.tree.nodeCache.delete(this.id);
        this.startIndex = -1;
        this.endIndex = -1;
        for (const child of this.children) {
            child._invalidateRecursively();
        }
    }

    /**
     * Replaces this node with another node or text.
     * @param {string | SourceNode<any> | SourceNode<any>[] | SourceTree<any>} content The node or text to replace with.
     * @param {boolean} [morphIdentity=true] Whether the current node should morph into the replacement node, preserving the current node's AST reference.
     * @returns {SourceNode<any> | SourceNode<any>[] | null}
     */
    replaceWith(content: string | SourceNode<any> | SourceNode<any>[] | SourceTree<any>, morphIdentity: boolean = true): SourceNode<any> | SourceNode<any>[] | null {
        let tree = this.tree;
        let start = this.startIndex;
        let end = this.endIndex;
        let parent = this.parent;
        let idx = -1;

        if (start === -1 || (this as any)._detachedParent) {
            const dp = (this as any)._detachedParent as SourceNode<any>;
            const di = (this as any)._detachedIndex ?? -1;
            if (dp && di > -1) {
                // Re-attachment case: Use the detached parent's context
                tree = dp.tree;
                parent = dp;
                idx = di;
                // Since it was removed from the source, it covers a 0-length range at its old position
                if (di === 0) {
                    start = end = dp.startIndex;
                } else if (dp.children[di - 1]) {
                    start = end = dp.children[di - 1].endIndex;
                } else {
                    start = end = dp.startIndex;
                }
            } else if (start === -1) {
                // Truly invalidated node with no re-attachment context
                return (typeof content === 'string')
                    ? SourceTree.fragment<any>(content, this.tree.language)
                    : (content as any);
            }
        } else {
            if (parent) idx = parent.children.indexOf(this as any);
        }

        const node = this as SourceNode<any>;

        if (content instanceof SourceNode || content instanceof SourceTree || Array.isArray(content)) {
            // Language check warning
            const checkNode = (n: any) => {
                if (typeof n === 'string' || n === null || n === undefined) return;
                const targetLang = n instanceof SourceNode ? n.tree.language : (n instanceof SourceTree ? n.language : undefined);
                if (targetLang && targetLang !== tree.language) {
                    console.warn(`[UPP WARNING] Mixing nodes from different languages. This may lead to parsing errors.`);
                }
            };
            if (content instanceof SourceNode) checkNode(content);
            else if (content instanceof SourceTree) checkNode(content);
            else if (Array.isArray(content)) (content as any[]).forEach(checkNode);
        }
        if (Array.isArray(content)) {
            content = content.filter(x => x !== null && x !== undefined);
        }

        const isWrapper = content instanceof SourceNode && (content === this || (content as any).find((child: SourceNode<any>) => child === this).length > 0);
        const isNewObject = (content instanceof SourceNode || content instanceof SourceTree) &&
            (isWrapper || content.type !== this.type);
        let newNode = content;
        const originalText = this.text;
        const oldCaptured = this._capturedText;

        const oldChildren = this.children;
        const snapshotIdentity = (nodes: SourceNode<any>[]) => {
            for (const n of nodes) {
                n._snapshotSearchable = n.searchableText;
                snapshotIdentity(n.children);
            }
        };
        snapshotIdentity(oldChildren);

        if (Array.isArray(newNode)) {
            // ... (rest of array logic)
            // No changes here for now as Array replacement usually implies identity loss unless we add more checks
        }

        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment<any>(newNode, this.tree.language);
        }

        let newText = "";
        if (Array.isArray(newNode)) {
            newText = newNode.map(n => {
                if (typeof n === 'string') return n;
                if (n as any instanceof SourceNode) return (n as any).text;
                if (n as any instanceof SourceTree) return (n as any).source;
                return String(n);
            }).join("");
        } else if (newNode instanceof SourceTree) {
            newText = newNode.source;
        } else {
            newText = (newNode as any).text || "";
        }

        tree.edit(start, end, newText);

        const attached = this._attachNewNode(newNode, start);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);
        for (const newNode of attachedList) {
            newNode.parent = this.parent;
        }

        // re-point current node if there is at least one new node
        if (attachedList.length > 0 && !isNewObject && morphIdentity) {
            const firstNew = attachedList[0] as SourceNode<any>;
            const oldId = this.id;

            // We want to KEEP the same object identity.
            // But we update all properties from the new node.
            const newChildren = firstNew.children;
            const newStartIndex = firstNew.startIndex;
            const newEndIndex = firstNew.endIndex;
            const newType = firstNew.type;
            const newData = firstNew.data;

            this.startIndex = newStartIndex;
            this.endIndex = newEndIndex;
            (this as any).type = newType;
            // Recursive identity transfer (important for structural morphing like renames)
            const transferIdentity = (oldNodes: SourceNode<any>[], newNodes: SourceNode<any>[]) => {
                // Heuristic: If we have exactly one identifier in both, it's likely a rename
                const oldIds = oldNodes.filter(c => c.type === 'identifier' || c.type === 'type_identifier');
                const newIds = newNodes.filter(c => c.type === 'identifier' || c.type === 'type_identifier');
                if (oldIds.length === 1 && newIds.length === 1) {
                    const oldIdNode = oldIds[0];
                    const newIdNode = newIds[0];
                    if (newIdNode._capturedText === undefined) {
                        newIdNode._capturedText = oldIdNode._snapshotSearchable || oldIdNode.text;
                    }
                }
                // Also match by fieldName?
                for (const oldChild of oldNodes) {
                    if (!oldChild.fieldName) continue;
                    const newChild = newNodes.find(c => c.fieldName === oldChild.fieldName);
                    if (newChild && newChild.type === oldChild.type) {
                        transferIdentity(oldChild.children, newChild.children);
                    }
                }
            };

            const prevChildren = this.children;
            this.children = newChildren;
            this.data = newData;
            transferIdentity(prevChildren, this.children);

            // Preserve captured text (important for stable symbol resolution during renames)
            if (oldCaptured !== undefined) {
                this._capturedText = oldCaptured;
            } else if (firstNew._capturedText !== undefined) {
                this._capturedText = firstNew._capturedText;
            } else if (originalText !== newText && (this.type === 'identifier' || (this.type as string) === 'type_identifier')) {
                // If it's a rename of an identifier, capture the old name for symbol resolution continuity
                this._capturedText = originalText;
            }



            // Update children parent pointers to this (morphed) node
            for (const child of this.children) {
                child.parent = this;
            }

            // Ensure ID is updated so we match the new tree-sitter node in subsequent wraps
            if (firstNew.id !== oldId) {
                this.tree.nodeCache.delete(oldId);
                this.id = firstNew.id;
            }
            this.tree.nodeCache.set(this.id, this);

            // Crucially, the survivor in the tree must be 'this', not 'firstNew'
            attachedList[0] = this;
        }

        // Update parent children
        if (parent && idx > -1) {
            attachedList.forEach(n => n.parent = parent);
            parent.children.splice(idx, 1, ...attachedList);
        }

        return attachedList.length === 1 ? attachedList[0] : (attachedList.length === 0 ? null : attachedList as any);
    }

    /**
     * Inserts a node or text after this node.
     * @param {SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>} content The node or text to insert.
     * @returns {SourceNode<any> | SourceNode<any>[]}
     */
    insertAfter(content: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>): SourceNode<any> | SourceNode<any>[] {
        const tree = this.tree;
        if (content instanceof SourceNode || content instanceof SourceTree || Array.isArray(content)) {
            const checkNode = (n: any) => {
                if (n instanceof SourceNode && n.tree && n.tree.language !== tree.language) {
                    console.warn(`[UPP WARNING] Mixing nodes from different languages. This may lead to parsing errors.`);
                }
            };
            if (content instanceof SourceNode) checkNode(content);
            else if (content instanceof SourceTree) checkNode(content.root);
            else if (Array.isArray(content)) (content as any[]).forEach(checkNode);
        }
        let newNode: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string> = content;
        if (Array.isArray(newNode)) {
            newNode = newNode.filter(x => x !== null && x !== undefined);
        }
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment<any>(newNode, this.tree.language);
        }
        let text = "";
        if (Array.isArray(newNode)) {
            text = (newNode as any[]).map(n => {
                if (typeof n === 'string') return n;
                if (n as any instanceof SourceNode) return (n as any).text;
                if (n as any instanceof SourceTree) return (n as any).source;
                return String(n);
            }).join("");
        } else if (newNode instanceof SourceTree) {
            text = newNode.source;
        } else {
            text = (newNode as any).text || "";
        }

        // Insert at END of this node
        const insertPos = this.endIndex;
        this.tree.edit(insertPos, insertPos, text);

        const attached = this._attachNewNode(newNode, insertPos);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

        if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx > -1) {
                attachedList.forEach(n => n.parent = this.parent);
                this.parent.children.splice(idx + 1, 0, ...attachedList);
            }
        }

        return attached as SourceNode | SourceNode[];
    }

    /**
     * Inserts a node or text before this node.
     * @param {SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>} content The node or text to insert.
     * @returns {SourceNode<any> | SourceNode<any>[]}
     */
    /** @returns {SourceNode<any>[]} All children (including unnamed like '{', ';', etc.) */
    get allChildren(): SourceNode<any>[] {
        return this.children;
    }

    insertBefore(content: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>): SourceNode<any> | SourceNode<any>[] {
        if (!this.parent) return this.insertAt(-1, content);
        const siblings = this.parent.allChildren;
        return this.parent.insertAt(siblings.indexOf(this), content);
    }

    /**
     * Inserts a node or text at a specific child index (including unnamed children).
     * @param {number} idx The child index to insert at.
     * @param {SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>} content The node or text to insert.
     * @returns {SourceNode<any> | SourceNode<any>[]}
     */
    insertAt(idx: number, content: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>): SourceNode<any> | SourceNode<any>[] {
        const tree = this.tree;
        let newNode: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string> = content;
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment<any>(newNode, this.tree.language);
        }
        let text = "";
        if (Array.isArray(newNode)) {
            text = (newNode as any[]).map(n => {
                if (typeof n === 'string') return n;
                if (n as any instanceof SourceNode) return (n as any).text;
                if (n as any instanceof SourceTree) return (n as any).source;
                return String(n);
            }).join("");
        } else if (newNode instanceof SourceTree) {
            text = newNode.source;
        } else {
            text = (newNode as any).text || "";
        }

        // Use children array if it's the root, otherwise use allChildren getter context
        // Actually, we want to insert relative to ALL children (named and unnamed)
        const currentChildren = this.allChildren;

        // Determine absolute insertion position in the tree
        let insertPos: number = this.startIndex;
        if (idx >= 0 && idx < currentChildren.length) {
            insertPos = currentChildren[idx].startIndex;
        } else if (idx >= currentChildren.length) {
            insertPos = this.endIndex;
        }

        this.tree.edit(insertPos, insertPos, text);

        const attached = this._attachNewNode(newNode, insertPos);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

        // Manually update the children array of the parent to include new nodes.
        // This is critical because tree-sitter re-parsing isn't automated for every edit.
        for (const newNode of attachedList) {
            newNode.parent = this;
        }

        if (idx === -1) {
            this.children.unshift(...attachedList.filter(n => n.isNamed));
        } else {
            // Find correct insertion point in the named children array
            // This is a bit complex because idx is relative to allChildren.
            // But we can just rebuild children from attached nodes? No.
            // Easiest: clear children list and it will be re-populated? No, it's not a getter yet.

            // For now, let's just make sure they are in the children array.
            const namedAttached = attachedList.filter(n => n.isNamed);
            this.children.push(...namedAttached);
            // Sort by startIndex to keep it consistent
            this.children.sort((a, b) => a.startIndex - b.startIndex);
        }

        return attached as SourceNode | SourceNode[];
    }

    /**
     * Internal method to attach a new node (or text/tree/array) to this node's tree at a specific offset.
     * @param {SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>} newNode - The content to attach.
     * @param {number} insertionOffset - The absolute start index in the tree.
     * @returns {SourceNode<any> | SourceNode<any>[] | null}
     */
    public _attachNewNode(newNode: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>, insertionOffset: number): SourceNode<any> | SourceNode<any>[] | null {
        if (Array.isArray(newNode)) {
            let currentOffset = insertionOffset;
            const results: SourceNode<any>[] = [];
            for (const item of newNode) {
                const attached = this._attachNewNode(item, currentOffset);
                if (Array.isArray(attached)) {
                    results.push(...attached);
                    attached.forEach(n => currentOffset += n.text.length);
                } else if (attached) {
                    results.push(attached);
                    currentOffset += attached.text.length;
                } else if (typeof item === 'string') {
                    currentOffset += item.length;
                }
            }
            return results;
        }

        let rootNode: SourceNode<any> | null = null;
        if (newNode instanceof SourceNode) {
            const delta = insertionOffset - newNode.startIndex;

            const migrate = (n: SourceNode<any>) => {
                const oldTree = n.tree;
                const oldId = n.id;

                // If moving between trees or if ID changed, update cache
                // We always update to be safe during complex migrations
                if (oldTree) oldTree.nodeCache.delete(oldId);

                n.tree = this.tree;
                n.startIndex += delta;
                n.endIndex += delta;

                this.tree.nodeCache.set(n.id, n);
                n.children.forEach(migrate);
            };

            migrate(newNode);
            rootNode = newNode;
        } else if (newNode instanceof SourceTree) {
            rootNode = newNode.root;
            newNode.mergeInto(this.tree, insertionOffset);
        }

        if (rootNode && rootNode.type === 'translation_unit') {
            return rootNode.children;
        }
        return rootNode;
    }

    /**
     * Finds nodes by type or predicate using simple recursive iteration.
     * Unlike match(), find() is based on node types, not structural code patterns.
     * Use this for simple type-based searches (e.g. finding all 'return_statement's).
     * 
     * @param {K | function(SourceNode<any>): boolean} predicate - Type name or filter function.
     * @returns {SourceNode<K>[]}
     */
    find<K extends string>(predicate: K | ((n: SourceNode<any>) => boolean)): SourceNode<K>[] {
        const results: SourceNode<any>[] = [];
        const isMatch = typeof predicate === 'string'
            ? (n: SourceNode<any>) => n.type === predicate
            : predicate;

        const walk = (n: SourceNode<any>) => {
            if (isMatch(n)) results.push(n);
            for (const child of n.children) {
                walk(child);
            }
        };

        walk(this);
        return results as SourceNode<K>[];
    }

    /**
     * Finds the smallest descendant that contains the given index range.
     * @param {number} start - Start index.
     * @param {number} end - End index.
     * @returns {SourceNode<any>}
     */
    descendantForIndex(start: number, end: number): SourceNode<any> {
        let current: SourceNode<any> = this;
        let found = true;
        while (found) {
            found = false;
            for (const child of current.children) {
                if (child.startIndex !== -1 && child.startIndex <= start && child.endIndex >= end) {
                    current = child;
                    found = true;
                    break;
                }
            }
        }
        return current;
    }


    /**
     * Appends a node or text as a child of this node.
     * Requires the node to already have children to use as anchors.
     * @param {SourceNode<any> | SourceTree<any> | string} newNode - The node or text to append.
     * @returns {SourceNode<any> | SourceNode<any>[]}
     */
    append(newNode: SourceNode<any> | SourceTree<any> | string): SourceNode<any> | SourceNode<any>[] {
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment<any>(newNode, this.tree.language);
        }
        const text = (newNode as any).text;

        if (this.children.length === 0) {
            return this.replaceWith(newNode) as any;
        }

        const lastChild = this.children[this.children.length - 1];
        return lastChild.insertAfter(newNode);
    }

    /**
     * Creates a deep clone of the node by parsing its text as a new fragment.
     * @returns {SourceNode<T>} A new node instance with the same content but fresh identity.
     */
    public clone(): SourceNode<T> {
        const tempTree = new SourceTree<any>(this.text, this.tree.language);
        const clonedNode = tempTree.root as any;

        const propagateData = (n: SourceNode<any>) => {
            n.data = { ...this.data };
            for (const child of n.children) {
                propagateData(child);
            }
        };
        propagateData(clonedNode);

        return clonedNode;
    }
}

