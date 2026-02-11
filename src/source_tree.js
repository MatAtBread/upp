import Parser from 'tree-sitter';

/**
 * Represents a source file as a manageable tree of nodes, 
 * providing an API for live source code manipulation.
 */
export class SourceTree {
    /**
     * @param {string} source Initial source code text.
     * @param {import('tree-sitter')} language Tree-sitter language object.
     */
    constructor(source, language) {
        /** @type {string} */
        this.source = source;
        /** @type {import('tree-sitter')} */
        this.language = language;
        /** @type {Parser} */
        this.parser = new Parser();
        this.parser.setLanguage(language);

        // Initial parse
        /** @type {import('tree-sitter').Tree} */
        this.tree = this.parser.parse(source);

        /** @type {Map<string, SourceNode>} Map of TreeSitterNode.id -> SourceNode */
        this.nodeCache = new Map();

        /** @type {SourceNode} The root node of the tree. */
        this.root = this.wrap(this.tree.rootNode);
    }

    /**
     * Internal method to get or create a SourceNode wrapper for a Tree-sitter node.
     * @param {import('tree-sitter').SyntaxNode} tsNode The Tree-sitter node to wrap.
     * @param {SourceNode} [parent] The parent SourceNode, if any.
     * @returns {SourceNode|null}
     */
    wrap(tsNode, parent = null) {
        if (!tsNode) return null;
        if (this.nodeCache.has(tsNode.id)) {
            const node = this.nodeCache.get(tsNode.id);
            if (parent) node.parent = parent;
            return node;
        }

        const node = new SourceNode(this, tsNode);
        node.parent = parent;
        this.nodeCache.set(tsNode.id, node);
        return node;
    }

    /**
     * Apply a specialized splice to the source string and update tracking for all active nodes.
     * @param {number} start The start index of the edit.
     * @param {number} end The end index of the edit.
     * @param {string} newText The replacement text.
     */
    edit(start, end, newText) {
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
    get startIndex() { return 0; }
    /** @returns {number} */
    get endIndex() { return this.source.length; }
    /** @returns {string} */
    get type() { return 'fragment'; }
    /** @returns {SourceNode[]} */
    get children() { return this.root.children; }
    /** @returns {string} */
    get text() { return this.source; }
    /** @param {string} val */
    set text(val) { this.edit(0, this.source.length, val); }

    /**
     * Creates a SourceNode from a code fragment.
     * Tries to parse as valid code; if it fails, wraps in a dummy function to parse statements/expressions.
     * @param {string} code The text fragment to parse.
     * @param {import('tree-sitter')} language Tree-sitter language object.
     * @returns {SourceNode}
     */
    static fragment(code, language) {
        const parser = new Parser();
        parser.setLanguage(language);
        let tree = parser.parse(code);

        let hasError = false;
        if (typeof tree.rootNode.hasError === 'function') {
            hasError = tree.rootNode.hasError();
        } else {
            hasError = tree.rootNode.toString().includes("ERROR");
        }

        if (!hasError) {
            const root = tree.rootNode;
            let isTopLevel = true;

            for (let i = 0; i < root.childCount; i++) {
                const type = root.children[i].type;
                if (!['function_definition', 'declaration', 'preproc_def', 'preproc_include', 'preproc_ifdef', 'type_definition'].includes(type)) {
                    isTopLevel = false;
                    break;
                }
            }

            if (isTopLevel && root.childCount > 0) {
                return new SourceTree(code, language).root;
            }
        }

        // 2. Try wrapping in a function (for statements/expressions)
        const wrappedCode = `void __frag() { ${code} }`;
        const wrappedTree = new SourceTree(wrappedCode, language);

        const funcDef = wrappedTree.root.children.find(c => c.type === 'function_definition');
        if (!funcDef) throw new Error("Failed to parse wrapped fragment.");

        const body = funcDef.children.find(c => c.type === 'compound_statement');
        if (!body) throw new Error("Failed to parse wrapped fragment body.");

        const innerNodes = body.children.filter(c => c.type !== '{' && c.type !== '}');

        if (innerNodes.length === 0) {
            return new SourceTree("", language).root;
        }

        if (innerNodes.length === 1) {
            // Return just the single node, but it must be migrated to its own tree to be independent
            const node = innerNodes[0];
            const text = node.text;
            const fragTree = new SourceTree(text, language);
            // Return the first child of the translation_unit (the actual node)
            return fragTree.root.children[0] || fragTree.root;
        }

        // Multiple nodes? Create a new SourceTree with just those nodes' text.
        const combinedText = innerNodes.map(n => n.text).join('\n');
        const finalTree = new SourceTree(combinedText, language);
        return finalTree.root;
    }

    /**
     * Serializes the tree to JSON, avoiding circular references.
     * @returns {Object}
     */
    toJSON() {
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
    mergeInto(targetTree, offset) {
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
export class SourceNode {
    /**
     * @param {SourceTree} tree The tree this node belongs to.
     * @param {import('tree-sitter').SyntaxNode} [tsNode] The Tree-sitter node to wrap.
     */
    constructor(tree, tsNode) {
        /** @type {SourceTree} */
        this.tree = tree;
        if (tsNode) {
            /** @type {string|number} */
            this.id = tsNode.id;
            /** @type {string} */
            this.type = tsNode.type;
            /** @type {number} */
            this.startIndex = tsNode.startIndex;
            /** @type {number} */
            this.endIndex = tsNode.endIndex;
            /** @type {SourceNode[]} */
            this.children = [];
            /** @type {SourceNode|null} */
            this.parent = null;
            for (let i = 0; i < tsNode.childCount; i++) {
                this.children.push(tree.wrap(tsNode.child(i), this));
            }
        } else {
            /** @type {string} */
            this.id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
            /** @type {string} */
            this.type = 'fragment';
            /** @type {number} */
            this.startIndex = 0;
            /** @type {number} */
            this.endIndex = 0;
            /** @type {SourceNode[]} */
            this.children = [];
            /** @type {SourceNode|null} */
            this.parent = null;
        }
    }

    /** @returns {string} */
    get text() {
        return this.tree.source.slice(this.startIndex, this.endIndex);
    }

    /** @param {string} value */
    set text(value) {
        this.tree.edit(this.startIndex, this.endIndex, value);
    }

    /**
     * Internal method called by SourceTree when a global edit happens.
     * @param {number} editStart The start index of the edit.
     * @param {number} editEnd The end index of the edit.
     * @param {number} delta Offset change duration.
     */
    handleEdit(editStart, editEnd, delta) {
        if (this.startIndex === -1) return;

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
     * @returns {SourceTree}
     */
    remove() {
        // 1. Snapshot current text range.
        const cachedText = this.text;

        // 2. Create new holding tree with text.
        const newTree = new SourceTree(cachedText, this.tree.language);

        // 3. Migrate `this` node into newTree at offset 0.
        const oldStartIndex = this.startIndex;
        const oldEndIndex = this.endIndex;
        const oldTree = this.tree;

        // Recursive migration function
        const migrate = (n, offsetDelta) => {
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
    _invalidateRecursively() {
        this.tree.nodeCache.delete(this.id);
        this.startIndex = -1;
        this.endIndex = -1;
        for (const child of this.children) {
            child._invalidateRecursively();
        }
    }

    /**
     * Replaces this node with another node or text.
     * @param {SourceNode|SourceTree|string} newNode The node or text to replace with.
     * @returns {SourceNode}
     */
    replaceWith(newNode) {
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment(newNode, this.tree.language);
        }

        const start = this.startIndex;
        const end = this.endIndex;
        const newText = newNode.text;

        // Capture parent before we are detached
        const parent = this.parent;
        let idx = -1;
        if (parent) {
            idx = parent.children.indexOf(this);
        }

        this.tree.edit(start, end, newText);

        // Deeply invalidate self and children
        this._invalidateRecursively();

        const attached = this._attachNewNode(newNode, start);
        const attachedList = Array.isArray(attached) ? attached : (attached ? [attached] : []);

        // re-point current node if there is at least one new node
        if (attachedList.length > 0) {
            const firstNew = attachedList[0];
            Object.assign(this, firstNew);
            // After Object.assign, 'this' has the same children array as firstNew.
            // These children were created pointing to firstNew; update them to point to 'this'.
            for (const child of this.children) {
                child.parent = this;
            }
            this.tree.nodeCache.set(this.id, this);
        }

        // Update parent children
        if (parent && idx > -1) {
            attachedList.forEach(n => n.parent = parent);
            parent.children.splice(idx, 1, ...attachedList);
        }

        return attached;
    }

    /**
     * Inserts a node or text after this node.
     * @param {SourceNode|SourceTree|string} newNode The node or text to insert.
     * @returns {SourceNode|SourceNode[]}
     */
    insertAfter(newNode) {
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment(newNode, this.tree.language);
        }
        const text = newNode.text;

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

        return attached;
    }

    /**
     * Inserts a node or text before this node.
     * @param {SourceNode|SourceTree|string} newNode The node or text to insert.
     * @returns {SourceNode|SourceNode[]}
     */
    insertBefore(newNode) {
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment(newNode, this.tree.language);
        }
        const text = newNode.text;

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

        return attached;
    }

    /**
     * Attaches a new node at a given offset within this node's tree,
     * @param {number} insertionOffset The absolute offset where to attach.
     * @returns {SourceNode|SourceNode[]}
     * @private
     */
    _attachNewNode(newNode, insertionOffset) {
        let rootNode = null;
        if (newNode instanceof SourceNode) {
            const delta = insertionOffset - newNode.startIndex;

            const migrate = (n) => {
                if (n.tree && n.tree !== this.tree) {
                    n.tree.nodeCache.delete(n.id);
                }
                if (n.tree !== this.tree) {
                    this.tree.nodeCache.set(n.id, n);
                }

                n.tree = this.tree;
                n.startIndex += delta;
                n.endIndex += delta;
                n.children.forEach(migrate);
            };

            migrate(newNode);
            rootNode = newNode;
        } else if (newNode.constructor && newNode.constructor.name === 'SourceTree') {
            rootNode = newNode.root;
            newNode.mergeInto(this.tree, insertionOffset);
        }

        if (rootNode && rootNode.type === 'translation_unit') {
            return rootNode.children;
        }
        return rootNode;
    }

    /**
     * Serializes the node to JSON, avoiding circular references (`tree` and `parent`).
     * @returns {Object}
     */
    toJSON() {
        return {
            id: this.id,
            type: this.type,
            startIndex: this.startIndex,
            endIndex: this.endIndex,
            text: this.text,
            children: this.children
        };
    }

    /**
     * Appends a node or text as a child of this node.
     * Requires the node to already have children to use as anchors.
     * @param {SourceNode|SourceTree|string} newNode The node or text to append.
     */
    append(newNode) {
        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment(newNode, this.tree.language);
        }

        const children = this.children;
        if (children.length > 0) {
            const lastChild = children[children.length - 1];
            return lastChild.insertAfter(newNode);
        } else {
            throw new Error("Generic append() not supported without an anchor child. Use insertAfter(child) instead.");
        }
    }
}
