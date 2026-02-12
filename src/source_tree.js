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
        if (typeof source !== 'string') {
            throw new Error(`SourceTree expects string source, got ${typeof source}`);
        }
        try {
            this.tree = this.parser.parse((index) => {
                if (index >= source.length) return null;
                return source.slice(index, index + 4096);
            });
        } catch (e) {
            throw e;
        }

        /** @type {Map<string, SourceNode>} Map of TreeSitterNode.id -> SourceNode */
        this.nodeCache = new Map();

        /** @type {SourceNode} The root node of the tree. */
        this.root = this.wrap(this.tree.rootNode);
    }

    /**
     * Internal method to get or create a SourceNode wrapper for a Tree-sitter node.
     * @param {import('tree-sitter').SyntaxNode} tsNode The Tree-sitter node to wrap.
     * @param {SourceNode} [parent] The parent SourceNode, if any.
     * @param {string} [fieldName] The field name for this node in the parent.
     * @returns {SourceNode|null}
     */
    wrap(tsNode, parent = null, fieldName = null) {
        if (!tsNode) return null;
        if (this.nodeCache.has(tsNode.id)) {
            const node = this.nodeCache.get(tsNode.id);
            if (parent) node.parent = parent;
            if (fieldName) node.fieldName = fieldName;
            return node;
        }

        const node = new SourceNode(this, tsNode);
        node.parent = parent;
        node.fieldName = fieldName;
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
        if (typeof code !== 'string') return code;

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
                return idNode;
            }
        }

        const parser = new Parser();
        parser.setLanguage(language);
        let tree = parser.parse((index) => {
            if (index >= code.length) return null;
            return code.slice(index, index + 4096);
        });

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

        const innerNodes = body.children.filter(c => c.type !== '{' && c.type !== '}' && c.text.length > 0);

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
        if (!tsNode || !tree) {
            throw new Error("SourceNode must be created with a Tree-sitter node.");
        }
        /** @type {SourceTree} */
        this.tree = tree;
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
        /** @type {string|null} */
        this.fieldName = null;
        for (let i = 0; i < tsNode.childCount; i++) {
            const child = tsNode.child(i);
            const fieldName = tsNode.fieldNameForChild(i);
            this.children.push(tree.wrap(child, this, fieldName));
        }

        /** @type {Array<{callback: Function, data: any}>} */
        this.markers = [];
        /** @type {Object} */
        this.data = {};
    }

    /** @returns {boolean} */
    get isNamed() {
        return this.type !== undefined && this.type !== null && !/^[^a-zA-Z_]/.test(this.type);
    }

    /** @returns {SourceNode|null} */
    get nextNamedSibling() {
        if (!this.parent) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx + 1; i < this.parent.children.length; i++) {
            const child = this.parent.children[i];
            if (child.isNamed) return child;
        }
        return null;
    }

    /** @returns {SourceNode|null} */
    get prevNamedSibling() {
        if (!this.parent) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx - 1; i >= 0; i--) {
            const child = this.parent.children[i];
            if (child.isNamed) return child;
        }
        return null;
    }

    /** @returns {number} */
    get namedChildCount() {
        return this.children.filter(c => c.isNamed).length;
    }

    /** 
     * @param {number} idx 
     * @returns {SourceNode|null} 
     */
    namedChild(idx) {
        const named = this.children.filter(c => c.isNamed);
        return named[idx] || null;
    }

    /** @returns {SourceNode|null} */
    get firstNamedChild() {
        return this.namedChild(0);
    }

    toString() {
        return this.text;
    }

    /** @returns {string} */
    get text() {
        if (this.startIndex === -1) return "";
        return this.tree.source.slice(this.startIndex, this.endIndex);
    }

    /** 
     * Returns the name to use for symbol resolution. 
     * Prioritizes _capturedText to allow resolution by original name after a rename.
     * @returns {string} 
     */
    get searchableText() {
        if (this._capturedText !== undefined) return this._capturedText.trim();
        return this.text.trim();
    }

    /** @param {string} value */
    set text(value) {
        this.replaceWith(value);
    }

    /** @returns {number} */
    get childCount() {
        return this.children.length;
    }

    get named() {
        return Object.fromEntries(this.children.filter(c => c.isNamed).map(c => [c.fieldName, c]));
    }
    /**
     * @returns {Object}
     */
    toJSON() {
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
     * @returns {SourceNode} 
     */
    child(idx) {
        return this.children[idx];
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
    replaceWith(newNodeContent) {
        const isNewObject = newNodeContent instanceof SourceNode || (newNodeContent && newNodeContent.constructor && newNodeContent.constructor.name === 'SourceTree');
        let newNode = newNodeContent;
        const originalText = this.text;
        const oldCaptured = this._capturedText;

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
            return attachedList.length === 1 ? attachedList[0] : (attachedList.length === 0 ? null : attachedList);
        }

        if (typeof newNode === 'string') {
            newNode = SourceTree.fragment(newNode, this.tree.language);
        }

        const start = this.startIndex;
        const end = this.endIndex;
        const newText = newNode.text || "";

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
            const firstNew = attachedList[0];
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
            this.type = newType;
            // Recursive identity transfer (important for structural morphing like renames)
            const transferIdentity = (oldNodes, newNodes) => {
                // Heuristic: If we have exactly one identifier in both, it's likely a rename
                const oldIds = oldNodes.filter(c => c.type === 'identifier' || c.type === 'type_identifier');
                const newIds = newNodes.filter(c => c.type === 'identifier' || c.type === 'type_identifier');
                if (oldIds.length === 1 && newIds.length === 1) {
                    const oldIdNode = oldIds[0];
                    const newIdNode = newIds[0];
                    if (newIdNode._capturedText === undefined) {
                        newIdNode._capturedText = oldIdNode.text;
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

            const oldChildren = this.children;
            this.children = newChildren;
            this.data = newData;
            transferIdentity(oldChildren, this.children);

            // Preserve captured text (important for stable symbol resolution during renames)
            if (oldCaptured !== undefined) {
                this._capturedText = oldCaptured;
            } else if (firstNew._capturedText !== undefined) {
                this._capturedText = firstNew._capturedText;
            } else if (originalText !== newText && (this.type === 'identifier' || this.type === 'type_identifier')) {
                // If it's a rename of an identifier, capture the old name for symbol resolution continuity
                this._capturedText = originalText;
            }

            // Markers: Should we take new ones? Usually yes as this is a new identity.
            this.markers = firstNew.markers;

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

        return attachedList.length === 1 ? attachedList[0] : (attachedList.length === 0 ? null : attachedList);
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

    _attachNewNode(newNode, insertionOffset) {
        if (Array.isArray(newNode)) {
            let currentOffset = insertionOffset;
            const results = [];
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

        let rootNode = null;
        if (newNode instanceof SourceNode) {
            const delta = insertionOffset - newNode.startIndex;

            const migrate = (n) => {
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
     * Finds nodes matching a predicate or type within this subtree.
     * @param {string|function(SourceNode):boolean} predicate Type name or filter function.
     * @returns {SourceNode[]}
     */
    find(predicate) {
        const results = [];
        const isMatch = typeof predicate === 'string'
            ? (n) => n.type === predicate
            : predicate;

        const walk = (n) => {
            if (isMatch(n)) results.push(n);
            for (const child of n.children) {
                walk(child);
            }
        };

        walk(this);
        return results;
    }

    /**
     * Finds the smallest descendant that contains the given index range.
     * @param {number} start 
     * @param {number} end 
     * @returns {SourceNode}
     */
    descendantForIndex(start, end) {
        let current = this;
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

    childForFieldName(fieldName) {
        return this.findChildByFieldName(fieldName);
    }

    /**
     * Finds a direct child by its field name.
     * @param {string} fieldName 
     * @returns {SourceNode|null}
     */
    findChildByFieldName(fieldName) {
        return this.children.find(c => c.fieldName === fieldName) || null;
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
