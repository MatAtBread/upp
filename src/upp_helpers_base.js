import Parser from 'tree-sitter';
import path from 'path';
const { Query } = Parser;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    /**
     * @param {import('./registry').Registry} registry - The registry instance.
     */
    constructor(registry) {
        /** @type {import('./registry').Registry} */
        this.registry = registry;
        /** @type {Array<Object>} */
        this.replacements = [];
        /** @type {Map<number, Object>} */
        this.replacementMap = new Map();
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.root = null;
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.contextNode = null;
        /** @type {Object|null} */
        this.invocation = null; // Current macro invocation details
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.lastConsumedNode = null;
        /** @type {boolean} */
        this.isDeferred = false;
        /** @type {Map<number, Object>} */
        this.nodeCache = new Map();
    }

    /**
     * Wraps a node to discourage direct upwards access.
     * @param {import('tree-sitter').SyntaxNode} node - The node to wrap.
     * @returns {import('tree-sitter').SyntaxNode}
     */
    wrapNode(node) {
        if (!node || node.__isWrapped) return node;

        // Check cache first by ID
        if (node.id !== undefined && this.nodeCache.has(node.id)) {
            return this.nodeCache.get(node.id);
        }

        const registry = this.registry;
        const helpers = this;

        // Use a simple proxy to intercept .parent and .rootNode
        const proxy = new Proxy(node, {
            get(target, prop) {
                if (prop === '__isWrapped') return true;
                if (prop === '__internal_raw_node') return target;
                if (prop === 'parent' || prop === 'rootNode') {
                    if (!helpers.isDeferred) {
                         const macroInfo = registry.activeMacro ? ` in macro @${registry.activeMacro}` : "";
                         registry.diagnostics.reportWarning(
                             0,
                             `Restricted access to node.${prop} detected${macroInfo}. Direct upwards AST access is discouraged. Use 'upp.inScope' or 'upp.atRoot' for robust transformations.`,
                             registry.filePath,
                             target.startPosition.row + 1,
                             target.startPosition.column + 1,
                             registry.sourceCode
                         );
                    }
                }
                const value = Reflect.get(target, prop);
                if (typeof value === 'function') {
                    return (...args) => {
                        let result = value.apply(target, args);
                        if (result && typeof result === 'object' && result.type) {
                             return helpers.wrapNode(result);
                        }
                        return result;
                    };
                }
                if (value && typeof value === 'object' && value.type) {
                    return helpers.wrapNode(value);
                }
                return value;
            }
        });

        if (node.id !== undefined) {
             this.nodeCache.set(node.id, proxy);
        }
        return proxy;
    }

    /**
     * Schedules a task to run at the root of the file after children are transformed.
     * @param {function(import('tree-sitter').SyntaxNode, UppHelpersBase): void} callback - The task function.
     */
    atRoot(callback) {
        this.registry.registerDeferredTask(callback, this.root.id);
    }

    /**
     * Schedules a task to run at the end of the enclosing scope.
     * @param {function(import('tree-sitter').SyntaxNode, UppHelpersBase): void} callback - The task function.
     */
    inScope(callback) {
        const scope = this.findEnclosing(this.contextNode || (this.invocation && this.invocation.invocationNode), 'compound_statement');
        if (!scope) {
            return this.atRoot(callback);
        }
        this.registry.registerDeferredTask(callback, scope.id);
    }

    /**
     * Gets the parent registry if available.
     * @returns {import('./registry').Registry|null}
     */
    get parentRegistry() {
        return this.registry.parentRegistry;
    }

    /**
     * Gets the parent tree's root node if available.
     * @returns {import('tree-sitter').SyntaxNode|null}
     */
    get parentTree() {
        if (this.registry.parentRegistry && this.registry.parentRegistry.mainTree) {
            return this.registry.parentRegistry.mainTree.rootNode;
        }
        return null;
    }

    /**
     * Debugs a node by printing its type and text.
     * @param {import('tree-sitter').SyntaxNode} node - The tree-sitter node to debug.
     */
    debug(node) {
        console.log(`Debug Node: type=${node.type}, text="${node.text.slice(0, 50)}${node.text.length > 50 ? '...' : ''}"`);
    }

    /**
     * Creates a unique identifier with the given prefix.
     * @param {string} [prefix='v'] - The prefix for the identifier.
     * @returns {string} A unique identifier.
     */
    createUniqueIdentifier(prefix = 'v') {
        const id = this.registry.idCounter++;
        return `${prefix}_${id}`;
    }

    /**
     * Tagged template literal for generating code and parse trees.
     * @param {TemplateStringsArray} strings - Template strings.
     * @param {...any} values - Interpolated values.
     * @returns {{text: string, tree: function(): import('tree-sitter').Tree}} An object containing the generated text and a lazy tree parser.
     */
    code(strings, ...values) {
        const result = strings.reduce((acc, str, i) => {
            let value = values[i] !== undefined ? values[i] : '';
            if (value && typeof value === 'object' && value.text !== undefined) {
                value = value.text;
            }
            return acc + str + value;
        }, '');

        return {
            text: result,
            tree: () => {
                const parser = new Parser();
                parser.setLanguage(this.registry.language);
                return parser.parse(result);
            }
        };
    }

    /**
     * Replaces a node with new content.
     * @param {import('tree-sitter').SyntaxNode|{start: number, end: number}} n - The node or range to replace.
     * @param {string|{text: string}} newContent - The new content string or object with text property.
     * @returns {string|null} A marker string if the replacement targets an ancestor, otherwise null.
     */
    replace(n, newContent) {
        const start = n.startIndex !== undefined ? n.startIndex : n.start;
        const end = n.endIndex !== undefined ? n.endIndex : n.end;

        let isGlobal = false;
        if (n.tree) {
            isGlobal = this.registry.mainTree && (n.tree === this.registry.mainTree);
        } else {
            isGlobal = (this === this.registry.helpers);
        }

        if (this.registry.isInsideInvocation(start, end)) {
            if (!(this.invocation && this.invocation.startIndex === start && this.invocation.endIndex === end)) {
                return;
            }
        }

        const replacement = {
            start: start,
            end: end,
            content: typeof newContent === 'object' ? newContent.text : String(newContent),
            isLocal: !isGlobal,
            node: n
        };

        if (isGlobal && this.registry.helpers !== this) {
            this.registry.helpers.replacements.push(replacement);
            if (n.id !== undefined) {
                this.registry.helpers.replacementMap.set(n.id, replacement);
            }
        } else {
            this.replacements.push(replacement);
            if (n.id !== undefined) {
                this.replacementMap.set(n.id, replacement);
            }
        }

        // Marker System: If this replacement targets a node ABOVE the current transformation context,
        // we should return a marker so the macro can embed it if needed.
        if (this.registry.activeTransformNode && n.id !== undefined) {
            const active = this.registry.activeTransformNode;
            let p = active.__internal_raw_node || active;
            while (p) {
                if (p.id === n.id) {
                    const markerId = `__UPP_MARKER_${++this.registry.markerCounter}__`;
                    this.registry.markerMap.set(markerId, replacement.content);
                    return markerId;
                }
                p = p.parent;
            }
        }

        return null;
    }

    /**
     * Gets a replacement for a node.
     * @param {import('tree-sitter').SyntaxNode} node - The node to check.
     * @returns {Object|null} The replacement object.
     */
    getReplacement(node) {
        if (!node) return null;
        let repl = this.replacementMap.get(node.id) || null;
        if (!repl && this.registry.helpers && this.registry.helpers !== this) {
            repl = this.registry.helpers.getReplacement(node);
        }
        return repl;
    }

    /**
     * Registers a global transformation function.
     * @param {function(import('tree-sitter').Tree, UppHelpersBase): void} transformFn - The transformation function.
     */
    registerTransform(transformFn) {
        this.registry.registerTransform(transformFn);
    }

    /**
     * Registers a transformation function on the PARENT registry.
     * @param {function(import('tree-sitter').Tree, UppHelpersBase): void} transformFn - The transformation function.
     */
    registerParentTransform(transformFn) {
        if (this.registry.parentRegistry) {
            this.registry.parentRegistry.registerTransform(transformFn);
        } else {
            console.warn("registerParentTransform called but no parent registry exists.");
        }
    }

    /**
     * Recursively walks the tree calling the callback for each node.
     * @param {import('tree-sitter').SyntaxNode} node - The starting node.
     * @param {function(import('tree-sitter').SyntaxNode): void} callback - The callback function.
     */
    walk(node, callback) {
        if (!node) return;
        const wrapped = this.wrapNode(node);
        callback(wrapped);
        const count = wrapped.childCount;
        for (let i = 0; i < count; i++) {
            try {
                this.walk(wrapped.child(i), callback);
            } catch (e) {
                // Ignore traversal errors for bad nodes (e.g. NodeClass constructor issues)
            }
        }
    }

    /**
     * Checks if a node has been consumed by a macro.
     * @param {import('tree-sitter').SyntaxNode} node - The node to check.
     * @returns {boolean} True if consumed.
     */
    isConsumed(node) {
        if (!node) return false;
        return this.registry.visitedNodes.get('consumed')?.has(node.id) || false;
    }

    /**
     * Finds the nearest enclosing node of a specific type.
     * @param {import('tree-sitter').SyntaxNode} node - The starting node.
     * @param {string} type - The node type to search for.
     * @returns {import('tree-sitter').SyntaxNode|null} The enclosing node or null.
     */
    findEnclosing(node, type) {
        if (!node) return null;
        let current = node;
        while (current) {
            if (current.type === type) return current;
            current = this.parent(current);
        }
        return null;
    }

    /**
     * Returns all subsequent named siblings of a node.
     * @param {import('tree-sitter').SyntaxNode} node - The reference node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} List of sibling nodes.
     */
    nextSiblings(node) {
        const siblings = [];
        let current = node.nextNamedSibling;
        while (current) {
            siblings.push(current);
            current = current.nextNamedSibling;
        }
        return siblings;
    }

    /**
     * Executes a tree-sitter query.
     * @param {string} pattern - The S-expression query pattern.
     * @param {import('tree-sitter').SyntaxNode} [node] - The scope node for the query.
     * @returns {Array<{pattern: number, captures: Object<string, import('tree-sitter').SyntaxNode>}>} Query matches with named captures.
     */
    query(pattern, node) {
        const query = new Query(this.registry.language, pattern);
        let targetNode = node || this.root;
        const raw = targetNode ? (targetNode.__internal_raw_node || targetNode) : null;
        if (raw && raw.rootNode) {
            targetNode = raw.rootNode;
        }
        if (!targetNode) {
            console.error("UppHelpersBase.query: targetNode is null/undefined");
            return [];
        }
        const matches = query.matches(targetNode.__internal_raw_node || targetNode);

        return matches.map(m => {
            const captures = {};
            for (const c of m.captures) {
                captures[c.name] = c.node;
            }
            return {
                pattern: m.pattern,
                captures: captures
            };
        });
    }

    /**
     * Consumes the next available node, optionally validating its type.
     * Automatically marks the consumed node for deletion.
     * @param {string|string[]|{type: string|string[], message: string, validate: function(import('tree-sitter').SyntaxNode): boolean}} [expectedTypeOrOptions] - Expected type(s) or validation options.
     * @param {string} [errorMessage] - Custom error message if validation fails.
     * @returns {import('tree-sitter').SyntaxNode|null} The consumed node.
     */
    consume(expectedTypeOrOptions, errorMessage) {
        let expectedTypes = null;
        let internalErrorMessage = errorMessage;
        let validateFn = null;

        if (typeof expectedTypeOrOptions === 'string') {
            expectedTypes = [expectedTypeOrOptions];
        } else if (Array.isArray(expectedTypeOrOptions)) {
            expectedTypes = expectedTypeOrOptions;
        } else if (expectedTypeOrOptions && typeof expectedTypeOrOptions === 'object') {
            expectedTypes = Array.isArray(expectedTypeOrOptions.type) ? expectedTypeOrOptions.type : (expectedTypeOrOptions.type ? [expectedTypeOrOptions.type] : null);
            internalErrorMessage = expectedTypeOrOptions.message || errorMessage;
            validateFn = expectedTypeOrOptions.validate;
        }

        const reportFailure = (foundNode) => {
            const macroName = this.invocation ? `@${this.invocation.name}` : "macro";
            let msg = internalErrorMessage;

            if (!msg) {
                const expectedStr = expectedTypes ? expectedTypes.join(' or ') : 'an additional code block';
                const foundStr = foundNode ? `found ${foundNode.type}` : 'nothing found';
                msg = `${macroName} expected ${expectedStr}, but ${foundStr}`;
            }

            this.error(foundNode || (this.invocation && this.invocation.invocationNode) || this.contextNode, msg);
        };


        let node = null;
        if (!this.lastConsumedNode) {
            if (this.invocation && !this.invocation.hasNodeParam) {
                let candidate = this.contextNode;
                if (candidate && candidate.startIndex <= this.invocation.startIndex && candidate.endIndex >= this.invocation.endIndex) {
                    // Candidate covers the macro, so it's a parent/context, not the direct target sibling.
                } else {
                    node = candidate;
                }
            }
        }

        // Check for pending macro invocations in the gap
        if (this.currentInvocations) {
            let searchStart = this.invocation ? this.invocation.endIndex : 0;
            if (this.lastConsumedNode) {
                if (this.lastConsumedNode.endIndex !== undefined) {
                    searchStart = this.lastConsumedNode.endIndex;
                }
            } else if (this.invocation && !this.invocation.hasNodeParam && this.contextNode) {
                 // Start searching after the current invocation
                 searchStart = this.invocation.endIndex;
            }

            const candidates = this.currentInvocations.filter(i => i.startIndex >= searchStart && i !== this.invocation);
            candidates.sort((a,b) => a.startIndex - b.startIndex);
            const nextInv = candidates[0];

            if (nextInv) {
                const gap = this.registry.sourceCode.slice(searchStart, nextInv.startIndex);
                const isGapClean = !gap.trim() || (this.registry.config.comments && gap.trim().startsWith('/*'));

                if (isGapClean) {
                     this.replace({start: nextInv.startIndex, end: nextInv.endIndex}, "");
                     nextInv.skipped = true;

                     const text = this.registry.sourceCode.slice(nextInv.startIndex, nextInv.endIndex);
                     const fakeNode = {
                         type: 'macro_invocation',
                         text: text,
                         startIndex: nextInv.startIndex,
                         endIndex: nextInv.endIndex,
                         childCount: 0,
                         namedChildCount: 0,
                         toString: () => text
                     };
                     this.lastConsumedNode = fakeNode;
                     return fakeNode;
                }
            }
        }

        // Fallback to normal AST consumption
        if (!node) {
            let anchor = this.lastConsumedNode || this.contextNode;

            if (anchor) {
                if (anchor.type === 'macro_invocation') {
                    // Preceding macro in a gap. Search starts after its end.
                    let rootForSearch = this.root || (this.registry.mainTree ? this.registry.mainTree.rootNode : null);
                    let searchIdx = anchor.endIndex;

                    if (this.topLevelInvocation && this.registry.mainTree) {
                        rootForSearch = this.registry.mainTree.rootNode;
                        const isSelf = (anchor.id === this.invocation?.invocationNode?.id);
                        searchIdx = isSelf ? (this.topLevelInvocation.endIndex) : searchIdx;
                    }
                    node = this.findNextNodeAfter(rootForSearch, searchIdx);
                } else if (anchor.startIndex <= (this.invocation ? this.invocation.startIndex : 0) &&
                           anchor.endIndex >= (this.invocation ? this.invocation.endIndex : anchor.endIndex)) {
                    // Anchor is a parent node (COVERS the current invocation).
                    let searchIdx = this.invocation ? this.invocation.endIndex : anchor.startIndex;
                    let child = anchor.firstNamedChild;
                    while (child && child.startIndex < searchIdx) {
                        child = child.nextNamedSibling;
                    }
                    node = child;

                    if (!node) {
                        let rootForSearch = this.root || (this.registry.mainTree ? this.registry.mainTree.rootNode : null);
                        let searchIdx = this.invocation ? this.invocation.endIndex : anchor.startIndex;
                        if (this.topLevelInvocation && this.registry.mainTree) {
                            rootForSearch = this.registry.mainTree.rootNode;
                            searchIdx = this.topLevelInvocation.endIndex;
                        }
                        node = this.findNextNodeAfter(rootForSearch, searchIdx);
                    }
                } else {
                    node = anchor.nextNamedSibling;
                    while (node && node.type.includes('comment')) {
                        node = node.nextNamedSibling;
                    }
                }
            } else {
                let rootForSearch = this.root || (this.registry.mainTree ? this.registry.mainTree.rootNode : null);
                if (rootForSearch && this.invocation) {
                    const isLocal = (this.root && rootForSearch.id === this.root.id);
                    if (isLocal && this.topLevelInvocation && this.registry.mainTree) {
                        node = this.findNextNodeAfter(this.registry.mainTree.rootNode, this.topLevelInvocation.endIndex);
                    } else if (isLocal) {
                        node = this.findNextNodeAfter(rootForSearch, this.invocation.endIndex);
                    } else {
                        const anchorInv = this.topLevelInvocation || this.invocation;
                        const searchRoot = this.registry.mainTree ? this.registry.mainTree.rootNode : rootForSearch;
                        node = this.findNextNodeAfter(searchRoot, anchorInv.endIndex);
                    }
                } else if (rootForSearch) {
                    node = rootForSearch.namedChild(0);
                }
            }
        }

         if (!node) {
             if (expectedTypes || validateFn) reportFailure(null);
             return null;
         }

         while (node.parent && node.parent.startIndex === node.startIndex && node.parent.type !== 'translation_unit') {
             node = node.parent;
         }
        //  console.log(`DEBUG: consume after drilling: type=${node.type} text="${node.text.slice(0, 40)}${node.text.length > 40 ? '...' : ''}"`);

        if (node && (node.type === 'ERROR' || (expectedTypes && !expectedTypes.includes(node.type)))) {
            let current = node;
            while (current && current.namedChildCount > 0 && (!expectedTypes || !expectedTypes.includes(current.type))) {
                let firstChild = current.namedChild(0);
                if (firstChild && firstChild.startIndex === current.startIndex) {
                    current = firstChild;
                    if (expectedTypes && expectedTypes.includes(current.type)) {
                        node = current;
                        break;
                    }
                } else {
                    break;
                }
            }
            if (current && current.type === 'ERROR' && expectedTypes) {
                for (let i=0; i < current.namedChildCount; i++) {
                    const c = current.namedChild(i);
                    if (expectedTypes.includes(c.type)) {
                        node = c;
                        break;
                    }
                }
            }
        }

        if (expectedTypes && !expectedTypes.includes(node.type)) {
            reportFailure(node);
        }

        if (validateFn && !validateFn(node)) {
            reportFailure(node);
        }

        this.replace(node, "");
        this.lastConsumedNode = node;
        if (!this.registry.visitedNodes.has('consumed')) {
            this.registry.visitedNodes.set('consumed', new Set());
        }
        this.registry.visitedNodes.get('consumed').add(node.id);
        return this.wrapNode(node);
    }

    /**
     * Checks if a node is a descendant of a parent.
     * @param {import('tree-sitter').SyntaxNode} parent - The parent node.
     * @param {import('tree-sitter').SyntaxNode} node - The potential descendant.
     * @returns {boolean} True if node is a descendant.
     */
    isDescendant(parent, node) {
        let current = node;
        const rawParent = parent ? (parent.__internal_raw_node || parent) : null;
        while (current) {
            const rawCurrent = current.__internal_raw_node || current;
            if (rawCurrent === rawParent || rawCurrent.id === rawParent.id) return true;
            current = this.parent(current);
        }
        return false;
    }

    /**
     * Gets the parent node.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {import('tree-sitter').SyntaxNode|null} The parent node.
     */
    parent(node) {
        try {
            const raw = node ? (node.__internal_raw_node || node) : null;
            const p = raw ? raw.parent : null;
            return this.wrapNode(p);
        } catch (e) { return null; }
    }

    /**
     * Checks if two nodes are identical.
     * @param {import('tree-sitter').SyntaxNode} n1 - First node.
     * @param {import('tree-sitter').SyntaxNode} n2 - Second node.
     * @returns {boolean} True if same node.
     */
    isSameNode(n1, n2) {
        if (!n1 || !n2) return n1 === n2;
        return n1 === n2 || n1.id === n2.id;
    }

    /**
     * Gets the next named sibling.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {import('tree-sitter').SyntaxNode|null} The sibling node.
     */
    nextNamedSibling(node) {
        try { return node ? node.nextNamedSibling : null; } catch (e) { return null; }
    }

    /**
     * Gets a child node by index.
     * @param {import('tree-sitter').SyntaxNode} node - The parent node.
     * @param {number} index - The child index.
     * @returns {import('tree-sitter').SyntaxNode|null} The child node.
     */
    child(node, index) {
        try { return node ? node.child(index) : null; } catch (e) { return null; }
    }

    /**
     * Gets the number of children.
     * @param {import('tree-sitter').SyntaxNode} node - The parent node.
     * @returns {number} The child count.
     */
    childCount(node) {
        try { return node ? node.childCount : 0; } catch (e) { return 0; }
    }

    /**
     * Gets a child node by field name.
     * @param {import('tree-sitter').SyntaxNode} node - The parent node.
     * @param {string} name - The field name.
     * @returns {import('tree-sitter').SyntaxNode|null} The child node.
     */
    childForFieldName(node, name) {
        if (!node) return null;
        try {
            const child = node.childByFieldName ? node.childByFieldName(name) : null;
            if (child) return child;

            if (node.childCount && node.fieldNameForChild) {
                for (let i = 0; i < node.childCount; i++) {
                    if (node.fieldNameForChild(i) === name) {
                        return node.child(i);
                    }
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Gets the last named child.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {import('tree-sitter').SyntaxNode|null} The last named child.
     */
    lastNamedChild(node) {
        try { return node ? node.lastNamedChild : null; } catch (e) { return null; }
    }

    /**
     * Parses a code fragment into a fresh AST.
     * @param {string} text - The source code fragment.
     * @returns {import('tree-sitter').SyntaxNode} The root node of the fresh tree.
     */
    parseFragment(text) {
        try {
             const tree = this.registry._parse(text);
             return tree.rootNode;
        } catch (e) {
             console.error(`Fragment parse failed: ${e.message}`);
             return null;
        }
    }

    /**
     * Throws a UPP-specific error associated with a node.
     * @param {import('tree-sitter').SyntaxNode} node - The node where the error occurred.
     * @param {string} message - The error message.
     * @throws {Error} The associated error.
     */
    error(node, message) {
        const err = new Error(message);
        err.isUppError = true;
        err.node = node;
        throw err;
    }

    /**
     * Loads a dependency file.
     * @param {string} filePath - Path to the dependency.
     */
    loadDependency(filePath) {
        let resolvedPath = filePath;
        if (!path.isAbsolute(filePath)) {
            const resolved = this.registry.resolveInclude(filePath);
            if (resolved) {
                resolvedPath = resolved;
            }
        }
        this.registry.loadDependency(resolvedPath);
    }
    /**
     * Finds the first named node after a specific index.
     * @param {import('tree-sitter').SyntaxNode} root - The root node.
     * @param {number} index - The index to start from.
     * @returns {import('tree-sitter').SyntaxNode|null} The next node or null.
     */
    findNextNodeAfter(root, index) {
        if (!root) return null;

        let node = root.descendantForIndex(index, index);

        while (node && node.endIndex <= index) {
            if (node.nextNamedSibling) {
                node = node.nextNamedSibling;
                break;
            }
            node = node.parent;
            if (!node || node === root) break;
        }

        if (!node) return null;

        while (node) {
             let firstChild = null;
             for (let i = 0; i < node.namedChildCount; i++) {
                 const c = node.namedChild(i);
                 if (c.endIndex > index) {
                     firstChild = c;
                     break;
                 }
             }

             if (firstChild) {
                 if (firstChild.startIndex <= index) {
                     node = firstChild;
                 } else {
                     node = firstChild;
                     break;
                 }
             } else {
                 break;
             }
        }

        if (node) {
            while (node.parent && node.parent.startIndex === node.startIndex && node.parent.type !== 'translation_unit') {
                node = node.parent;
            }
        }

        const finalNode = node && node.isNamed ? node : (node ? node.nextNamedSibling : null);
        if (finalNode && finalNode.type === 'translation_unit') {
            //  console.log(`DEBUG: findNextNodeAfter found TU, returning null`);
             return null;
        }
        if (finalNode) {
            // console.log(`DEBUG: findNextNodeAfter result: type=${finalNode.type} range=${finalNode.startIndex}-${finalNode.endIndex}`);
        }
        return finalNode;
    }

    /**
     * Finds the nearest enclosing scope node.
     * @param {import('tree-sitter').SyntaxNode} node - The node.
     * @returns {import('tree-sitter').SyntaxNode|null} The scope node.
     */
    enclosingScope(node) {
        let p = node ? node.parent : null;
        while (p) {
            if (p.type === 'compound_statement' || p.type === 'function_definition' || p.type === 'translation_unit' || p.type === 'parameter_list') {
                return p;
            }
            p = p.parent;
        }
        return this.root;
    }

    /**
     * Finds the definition for a symbol (string or node).
     * @param {string|import('tree-sitter').SyntaxNode} target - Symbol name or identifier node.
     * @param {Object} [options] - Resolution options.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition node.
     */
    findDefinition(target, options) {
        if (!target) return null;
        if (typeof target === 'string') {
            return this.registry.resolveSymbol(target, this.contextNode || this.root, options);
        }
        return this.registry.getDefinition(target);
    }
}

export { UppHelpersBase };
