import Parser from 'tree-sitter';
import type { Tree, SyntaxNode } from 'tree-sitter';
import type { Marker } from './registry.ts';

/**
 * Represents a source file as a manageable tree of nodes, 
 * providing an API for live source code manipulation.
 */
export class SourceTree<NodeTypes extends string = string> {
    public source: string;
    public language: any;
    public parser: Parser;
    public tree: Tree;
    public nodeCache: Map<number | string, SourceNode<NodeTypes>>;
    public root: SourceNode<NodeTypes>;

    /**
     * @param {string} source Initial source code text.
     * @param {any} language Tree-sitter language object.
     */
    constructor(source: string, language: any) { // language is tree-sitter Language
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
     * @param {string | SourceNode | SourceTree} code The text fragment to parse.
     * @param {any} language Tree-sitter language object.
     * @returns {SourceNode}
     */
    static fragment<NodeTypes extends string = string>(code: string | SourceNode<any> | SourceTree<any>, language: any): SourceNode<NodeTypes> {
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
    toJSON(): any {
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
    public markers: Marker[];
    public data: Record<string, unknown>;
    public _capturedText?: string;
    public _snapshotSearchable?: string;

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

        this.markers = [];
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
     * @param {SourceNode<any>|SourceTree<any>|string|Array<SourceNode<any>|string>} newNodeContent The node or text to replace with.
     * @returns {SourceNode<any> | SourceNode<any>[] | null}
     */
    replaceWith(content: string | SourceNode<any> | SourceNode<any>[] | SourceTree<any>): SourceNode<any> | SourceNode<any>[] | null {
        const node = this as SourceNode<any>;
        const tree = node.tree;

        if (content instanceof SourceNode || content instanceof SourceTree || Array.isArray(content)) {
            // Language check warning
            const checkNode = (n: any) => {
                if (n instanceof SourceNode && n.tree && n.tree.language !== tree.language) {
                    console.warn(`[UPP WARNING] Mixing nodes from different languages. This may lead to parsing errors.`);
                }
            };
            if (content instanceof SourceNode) checkNode(content);
            else if (content instanceof SourceTree) checkNode(content.root);
            else if (Array.isArray(content)) (content as SourceNode<any>[]).forEach(checkNode);
        }
        if (Array.isArray(content)) {
            content = content.filter(x => x !== null && x !== undefined);
        }

        const isNewObject = content instanceof SourceNode || content instanceof SourceTree;
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
            // Handle array of nodes/text
            const textParts = newNode.map(n => typeof n === 'string' ? n : n.text);
            const combinedText = textParts.join('');
            const start = this.startIndex;
            const end = this.endIndex;
            this.tree.edit(start, end, combinedText);

            const attached = this._attachNewNode(newNode, start);
            const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

            // If we have parent, update it
            const parent = this.parent;
            if (parent) {
                const idx = parent.children.indexOf(this);
                if (idx > -1) {
                    attachedList.forEach(n => n.parent = parent);
                    parent.children.splice(idx, 1, ...attachedList);
                }
            }
            this.startIndex = -1; // Invalidate self
            return attachedList.length === 1 ? attachedList[0] : (attachedList.length === 0 ? null : attachedList as any);
        }

        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment<any>(newNode, this.tree.language);
        }

        const start = this.startIndex;
        const end = this.endIndex;
        const newText = (newNode as SourceNode<any>).text || "";

        // Capture parent before we are detached
        const parent = this.parent;
        let idx = -1;
        if (parent) {
            idx = parent.children.indexOf(this);
        }

        this.tree.edit(start, end, newText);

        const attached = this._attachNewNode(newNode, start);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

        // re-point current node if there is at least one new node
        if (attachedList.length > 0 && !isNewObject) {
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

            // Markers: Should we take new ones? Usually yes as this is a new identity.
            this.markers = firstNew.markers as any;

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
        } else if (attachedList.length === 0) {
            // If we replaced with nothing, THEN we invalidate self
            this.startIndex = -1;
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
     * @param {SourceNode<any>|SourceTree<any>|string} newNode The node or text to insert.
     * @returns {SourceNode<any>|SourceNode<any>[]}
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
        const text = Array.isArray(newNode)
            ? newNode.map(n => typeof n === 'string' ? n : n.text).join('')
            : (newNode as any).text;

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
     * @param {SourceNode<any>|SourceTree<any>|string} newNode The node or text to insert.
     * @returns {SourceNode<any>|SourceNode<any>[]}
     */
    insertBefore(content: SourceNode<any> | SourceTree<any> | string | Array<SourceNode<any> | string>): SourceNode<any> | SourceNode<any>[] {
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
        const text = Array.isArray(newNode)
            ? newNode.map(n => typeof n === 'string' ? n : n.text).join('')
            : (newNode as any).text;

        // Insert at START of this node
        const insertPos = this.startIndex;
        this.tree.edit(insertPos, insertPos, text);

        const attached = this._attachNewNode(newNode, insertPos);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

        if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx > -1) {
                attachedList.forEach(n => n.parent = this.parent);
                this.parent.children.splice(idx, 0, ...attachedList);
            }
        }

        return attached as SourceNode | SourceNode[];
    }

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
     * @param {K | function(SourceNode<any>):boolean} predicate Type name or filter function.
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
     * @param {number} start 
     * @param {number} end 
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
     * @param {SourceNode<any>|SourceTree<any>|string} newNode The node or text to append.
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
}
