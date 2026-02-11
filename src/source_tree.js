import Parser from 'tree-sitter';

export class SourceTree {
    constructor(source, language) {
        this.source = source;
        this.language = language;
        this.parser = new Parser();
        this.parser.setLanguage(language);

        // Initial parse
        this.tree = this.parser.parse(source);

        // Map of TreeSitterNode.id -> SourceNode
        this.nodeCache = new Map();

        // We wrap the root immediately
        this.root = this.wrap(this.tree.rootNode);
    }

    /**
     * Internal method to get or create a SourceNode wrapper
     */
    wrap(tsNode) {
        if (!tsNode) return null;
        if (this.nodeCache.has(tsNode.id)) {
            return this.nodeCache.get(tsNode.id);
        }

        const node = new SourceNode(this, tsNode);
        this.nodeCache.set(tsNode.id, node);
        return node;
    }

    /**
     * Apply a specialized splice to the source string and update tracking.
     */

    /**
     * Apply a specialized splice to the source string and update tracking.
     */
    edit(start, end, newText) {
        const oldLen = end - start;
        const newLen = newText.length;
        const delta = newLen - oldLen;

        // 1. Update source string
        this.source = this.source.slice(0, start) + newText + this.source.slice(end);

        // 2. Notify active nodes to shift their offsets
        // We capture values() in an array to avoid concurrent modification issues if any logic removes nodes
        const nodes = Array.from(this.nodeCache.values());
        for (const node of nodes) {
            node.handleEdit(start, end, delta);
        }
    }

    // Node Interface Methods (Delegated to Root)

    get startIndex() { return 0; }
    get endIndex() { return this.source.length; }
    get type() { return 'fragment'; } // Or root type
    get children() { return this.root.children; }
    get text() { return this.source; }
    set text(val) { this.edit(0, this.source.length, val); }

    /**
     * Creates a SourceNode from a code fragment.
     * Tries to parse as valid C. If it fails, wraps in a dummy function to parse statements/expressions.
     * @param {string} code
     * @param {any} language
     * @returns {SourceNode}
     */
    static fragment(code, language) {
        // 1. Try direct parse
        const parser = new Parser();
        parser.setLanguage(language);
        let tree = parser.parse(code);

        // Check for errors in the root or first child
        // Tree-sitter often produces an ERROR node if top-level structure is invalid.
        let hasError = false;
        if (typeof tree.rootNode.hasError === 'function') {
            hasError = tree.rootNode.hasError();
        } else if (typeof tree.rootNode.hasError === 'boolean') {
            hasError = tree.rootNode.hasError;
        }

        // Fallback: Check if ERROR node exists in string representation
        if (!hasError) {
             hasError = tree.rootNode.toString().includes("ERROR");
        }

        if (!hasError) {
             // Valid top-level code?
             // Some things parse "validly" but are not what we want (e.g. `return 0;` might be parsed as garbage or ERROR that we missed).
             // Actually `tree-sitter-c` parses `return 0;` as `ERROR` usually.
             // If `hasError` is false, it means it's a valid `translation_unit`.
             // But valid `translation_unit` can be empty or contain `declarations`.
             // `return 0;` is NOT a declaration.
             // If it parses as `translation_unit` with `ERROR` children, `tree.rootNode.hasError` should be true.

             // Check if root has ANY children that are ERROR?
             // The recursive `hasError()` check *should* cover this.

             // However, for safety, let's look at the structure.
             // If the code is short and looks like a statement (ends in semicolon, contains operators),
             // and the parse result is just a `translation_unit` without clear declarations, maybe we should wrap?

             // Better Heuristic:
             // If it's a `translation_unit` and the children are NOT `function_definition`, `declaration`, `preproc_def`, etc.
             // then it might be a statement that got parsed weirdly (or maybe as a pointer decl `int *x`?).

             // Let's rely on the user's intent:
             // If they pass `10 + 20`, it parses as `expression_statement` inside `translation_unit`?
             // No, top level expressions are invalid C.

             // Force WRAPPING if the root node type is `translation_unit` AND it contains `ERROR` descendants (even if hasError() lies?)
             // Or if we strongly suspect it needs wrapping.

             // Let's try to wrap if it's NOT a clear top-level definition.
             const root = tree.rootNode;
             let isTopLevel = true;
             console.log(`[DEBUG_FRAG] Toplevel parse: type=${root.type}, children=${root.childCount}`);

             for (let i = 0; i < root.childCount; i++) {
                 const type = root.children[i].type;
                 if (type === 'ERROR' || type === 'expression_statement') {
                      isTopLevel = false; // Statements at top level are invalid (or likely fragments)
                      break;
                 }
                 // Allowed top level:
                 // function_definition, declaration, preproc_*, type_definition, struct_specifier...
                 if (!['function_definition', 'declaration', 'preproc_def', 'preproc_include', 'preproc_ifdef', 'type_definition'].includes(type)) {
                      // Suspicious top level element?
                      // actually `return_statement` at top level is definitely wrong.
                      isTopLevel = false;
                 }
             }

             if (isTopLevel && !hasError) {
                 return new SourceTree(code, language).root;
             }
        }

        // 2. Try wrapping in a function (for statements/expressions)
        // void __frag() { <code> }
        const wrappedCode = `void __frag() { ${code} }`;
        const wrappedTree = new SourceTree(wrappedCode, language);

        // Extract the content inside the function body
        // root -> function_definition -> compound_statement -> (content)
        // compound_statement children: '{', ..., '}'
        // We want the children between braces.

        const funcDef = wrappedTree.root.children.find(c => c.type === 'function_definition');
        if (!funcDef) throw new Error("Failed to parse wrapped fragment.");

        const body = funcDef.children.find(c => c.type === 'compound_statement');
        if (!body) throw new Error("Failed to parse wrapped fragment body.");

        // We want to return a node that represents "the code".
        // If it's a single statement/expression, return that node?
        // If it's multiple, return the body (compound_statement)?
        // But the body includes '{' and '}'.
        // Users passing "return 0;" expect "return 0;" not "{ return 0; }".

        // Filter out '{' and '}'
        const innerNodes = body.children.filter(c => c.type !== '{' && c.type !== '}');

        if (innerNodes.length === 0) {
             // Empty fragment?
             return new SourceTree("", language).root;
        }

        if (innerNodes.length === 1) {
             return innerNodes[0];
        }

        // Multiple nodes? SourceNode API is 1:1 with TreeSitter Node.
        // We can't return a "list of nodes" as a single SourceNode unless we use the compound_statement.
        // But compound_statement has braces.
        // If the user inserts this, they get braces.
        // "int x; int y;" -> "{ int x; int y; }"
        // This might be acceptable for "fragment" behavior if it's multiple statements.
        // But if they just want the text?
        // We are returning a SourceNode.
        // Using the compiled text of the inner nodes?
        // We can create a new SourceTree with just the inner text?
        // But that puts us back at square 1 (parsing "int x; int y;" at top level might fail).

        // For now, if multiple statements, return the compound block.
        // Or better: Return a specialized container?
        // Let's return the `compound_statement` but warn?
        // Actually, for "10/2", it becomes an expression_statement.

        return body;
    }

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
        // We could detach our root, but it's now part of target.
    }
}

export class SourceNode {
    constructor(tree, tsNode) {
        this.tree = tree;
        if (tsNode) {
            this.id = tsNode.id;
            this.type = tsNode.type;
            this.startIndex = tsNode.startIndex;
            this.endIndex = tsNode.endIndex;
            this.children = [];
            for(let i=0; i<tsNode.childCount; i++) {
                this.children.push(tree.wrap(tsNode.child(i)));
            }
        } else {
             // Virtual/New Node should be created via new SourceTree(...)
             // Only internal logic should call this without a tsNode if supporting custom nodes.
             this.id = typeof crypto !== 'undefined' ? crypto.randomUUID() : Math.random().toString(36).slice(2);
             this.type = 'fragment';
             this.startIndex = 0;
             this.endIndex = 0;
             this.children = [];
        }
    }

    get text() {
        return this.tree.source.slice(this.startIndex, this.endIndex);
    }

    set text(value) {
        this.tree.edit(this.startIndex, this.endIndex, value);
    }

    /**
     * Called by SourceTree when a global edit happens.
     */
    /**
     * Called by SourceTree when a global edit happens.
     */
    handleEdit(editStart, editEnd, delta) {
        // Log if this is the failing vNode (type identifier, name z, in temp tree?)
        // Or if it's the node being edited (identifier 'fn', 'test_func').
        // Let's log for all 'identifier' and 'declarator' nodes to keep it concise?
        // Actually, just log everything if content is small, or filter by failing scenario.
        // Failing scenario: vNode with text "int z = 99;". Type=translation_unit (root of vTree)?
        // No, vTree.root.children[0] is declaration.

        // Debug
        if (this.text.includes("int z = 99") || this.type === 'identifier') {
             console.log(`[DEBUG_EDIT] Node ${this.id} (${this.type}) [${this.startIndex}-${this.endIndex}]: Edit [${editStart}-${editEnd}, d=${delta}]`);
        }

        // Case 1: Edit is completely AFTER this node. No change.
        if (this.endIndex <= editStart) return;

        // Case 2: Edit is completely BEFORE this node. Shift both.
        if (this.startIndex >= editEnd) {
            // console.log(`[DEBUG_EDIT] Shifting Node ${this.id} by ${delta}`);
            this.startIndex += delta;
            this.endIndex += delta;
            return;
        }

        // Case 3: Edit is INSIDE this node (or overlaps).
        // This node expands/contracts to contain the edit.
        this.endIndex += delta;
    }

    // --- DOM API ---

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

    replaceWith(newNode) {
        // Convert string to fragment
        if (typeof newNode === 'string') {
             newNode = SourceTree.fragment(newNode, this.tree.language);
        }

        const currentText = this.text;
        const newText = newNode.text;

        // 1. Perform edit
        this.tree.edit(this.startIndex, this.endIndex, newText);

        // 2. Invalidate self
        this.tree.nodeCache.delete(this.id);
        this.startIndex = -1;
        this.endIndex = -1;

        // 3. Attach newNode
        // We need to attach at the START of where we were.
        // `edit` updated offsets, so `this.startIndex` is -1.
        // We should have captured start before invalidating.

        // Actually, `replaceWith` logic in previous step was safer:
        // Use `_replaceRaw` helper to keep logic clean.
    }

    // Helper to perform the replacement logic correctly structure-wise
    _replaceRaw(newNode) {
         if (typeof newNode === 'string') {
             newNode = SourceTree.fragment(newNode, this.tree.language);
         }

         const start = this.startIndex;
         const end = this.endIndex;
         const newText = newNode.text;

         this.tree.edit(start, end, newText);

         // Invalidate self
         this.tree.nodeCache.delete(this.id);
         this.startIndex = -1;
         this.endIndex = -1;

         this._attachNewNode(newNode, start);
    }

    replaceWith(newNode) {
        this._replaceRaw(newNode);
    }

    insertAfter(newNode) {
        if (typeof newNode === 'string') {
             newNode = SourceTree.fragment(newNode, this.tree.language);
        }
        const text = newNode.text;

        // Insert at END of this node
        const insertPos = this.endIndex;
        this.tree.edit(insertPos, insertPos, text);

        this._attachNewNode(newNode, insertPos);
    }

    insertBefore(newNode) {
        if (typeof newNode === 'string') {
             newNode = SourceTree.fragment(newNode, this.tree.language);
        }
        const text = newNode.text;

        // Insert at START of this node
        const insertPos = this.startIndex;
        this.tree.edit(insertPos, insertPos, text);

        // `edit` shifts `this` node by `text.length`.
        // So the new content is at `insertPos`.
        // `this` is now at `insertPos + len`.

        this._attachNewNode(newNode, insertPos);
    }

    _attachNewNode(newNode, insertionOffset) {
         // Helper to migrate a SourceTree or SourceNode to this tree.
         if (newNode instanceof SourceNode) {
             const sourceTree = newNode.tree;
             const newStart = insertionOffset;
             const delta = newStart - newNode.startIndex;

             // Recursively update tree and offsets
             const migrate = (n) => {
                 // Remove from old tree cache if different
                 if (n.tree && n.tree !== this.tree) {
                      n.tree.nodeCache.delete(n.id);
                 }
                 // Add to new tree cache
                 if (n.tree !== this.tree) {
                      this.tree.nodeCache.set(n.id, n);
                 }

                 n.tree = this.tree;
                 n.startIndex += delta;
                 n.endIndex += delta;
                 n.children.forEach(migrate);
             };

             migrate(newNode);
         } else if (newNode.constructor && newNode.constructor.name === 'SourceTree') {
             newNode.mergeInto(this.tree, insertionOffset);
         }
    }

    append(newNode) {
         if (typeof newNode === 'string') {
             newNode = SourceTree.fragment(newNode, this.tree.language);
         }

         const children = this.children;
         if (children.length > 0) {
             const lastChild = children[children.length - 1];
             lastChild.insertAfter(newNode);
         } else {
             // Fallback: This is dangerous without knowing grammar.
             // e.g. `fn() {}`. startIndex points to `fn`, endIndex to `}`.
             // If we append to `fn`, do we mean "add argument"? "add body"?
             // DOM append() adds to the *content*.
             // Valid Assumption: If you treat a node as a container, you essentially mean "insert at end of inner range".
             // How do we find "inner range"?
             // We can use the text to guess? e.g. if ends with `}`, insert before it.
             // For now, let's throw or implement a "safe append" that requires an anchor.
             throw new Error("Generic append() not supported without an anchor child. Use insertAfter(child) instead.");
         }
    }
}
