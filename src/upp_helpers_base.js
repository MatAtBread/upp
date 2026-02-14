import { SourceNode } from './source_tree.js';

let uniqueIdCounter = 1;

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    get parentHelpers() { return this._parentHelpers; }
    set parentHelpers(v) { this._parentHelpers = v; }

    get isAuthoritative() { return this.registry.isAuthoritative; }
    set isAuthoritative(v) { this.registry.isAuthoritative = v; }

    constructor(root, registry, parentHelpers = null) {
        this.root = root;
        this.registry = registry;
        this.parentHelpers = parentHelpers; // Initial assignment will use the setter
        this.contextNode = null;
        this.invocation = null;
        this.lastConsumedNode = null;
        this.isDeferred = false;
        this.currentInvocations = [];
        this.consumedIds = new Set();
        this.context = null; // Back-reference to the local transform context
        this.parentTree = (registry && registry.parentRegistry) ? registry.parentRegistry.tree : null;
        this.stdPath = registry ? registry.stdPath : null;
    }


    codeTree(strings, ...values) {
        let text = "";
        const nodeMap = new Map();
        const usedNodes = new Set();

        const processValue = (val, index) => {
            if (val instanceof SourceNode) {
                if (!val.isValid) {
                    const nodeInfo = val.type ? `type: ${val.type}` : "unknown type";
                    console.warn(`[UPP WARNING] Macro substitution uses a stale node reference (${nodeInfo}). It may have been destroyed by a previous non-identity-preserving transformation. Falling back to text-only interpolation.`);
                    text += val.text;
                    return;
                }
                if (usedNodes.has(val)) {
                    throw new Error(`upp.codeTree: Node ${val.text} (type: ${val.type}) cannot be used more than once in a single codeTree template. Use \${node.text} to interpolate a clone of the node's text.`);
                }
                usedNodes.add(val);
                const placeholder = `__UPP_NODE_STABILITY_${this.createUniqueIdentifier('p')}`;
                nodeMap.set(placeholder, val);
                text += placeholder;
            } else if (val === null || val === undefined) {
                throw new Error(`upp.codeTree: Invalid null or undefined value at index ${index}`);
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

        const prepared = this.registry.prepareSource(text, this.registry.originPath);
        const cleanText = prepared.cleanSource;

        const SourceTree = this.registry.tree.constructor;
        const fragment = SourceTree.fragment(cleanText, this.registry.language);
        if (!fragment) {
            throw new Error("upp.codeTree: Failed to parse code fragment");
        }

        // Walk and replace placeholders with actual nodes
        const placeholders = Array.from(nodeMap.keys());
        for (const placeholder of placeholders) {
            const placeholderNodes = fragment.find(n => n.text === placeholder);
            if (placeholderNodes.length === 0) {
                // This might happen if the placeholder was somehow mangled or in a comment (though unlikely with our naming)
                throw new Error(`upp.codeTree: Placeholder ${placeholder} not found in parsed fragment`);
            }

            const originalNode = nodeMap.get(placeholder);
            originalNode.remove();

            // Replace placeholder with original node
            for (const pNode of placeholderNodes) {
                pNode.replaceWith(originalNode);
            }
        }

        return fragment;
    }

    atRoot(callback) {
        const root = this.findRoot();
        if (!root) return "";
        return this.withNode(root, callback);
    }

    withScope(callback) {
        const scope = this.findScope();
        if (!scope) return "";
        return this.withNode(scope, callback);
    }

    withRoot(callback) {
        return this.withNode(this.findRoot(), callback);
    }

    /**
     * @deprecated Use codeTree or withPattern instead.
     */
    registerTransform(callback) {
        return this.atRoot(callback);
    }

    registerTransformRule(rule) {
        this.registry.registerTransformRule(rule);
    }

    replace(n, newContent) {
        let finalContent = newContent;
        if (typeof finalContent === 'string' && finalContent.includes('@') && this.registry && this.registry.prepareSource) {
            const prepared = this.registry.prepareSource(finalContent, this.registry.originPath);
            finalContent = prepared.cleanSource;
        }

        if (n.replaceWith) {
            const result = n.replaceWith(finalContent);
            if (this.contextNode === n) this.contextNode = result;
            return result;
        }

        throw new Error(`Illegal call to helpers.replace(node, content).`);
    }

    insertBefore(n, content) {
        if (!n || !n.insertBefore) throw new Error(`Illegal call to helpers.insertBefore(node, content).`);
        return n.insertBefore(content);
    }

    insertAfter(n, content) {
        if (!n || !n.insertAfter) throw new Error(`Illegal call to helpers.insertAfter(node, content).`);
        return n.insertAfter(content);
    }

    findRoot() {
        return (this.context && this.context.tree) ? this.context.tree.root : this.root;
    }



    withNode(node, callback) {
        if (!node) return "";
        node.markers.push({
            callback: (target, helpers) => callback(target, helpers),
            data: {}
        });
        return "";
    }

    wrapNode(node) {
        return node; // No longer needed, but kept for compatibility during transition
    }

    /**
     * Finds macro invocations in the tree.
     * @param {string} macroName
     * @param {SourceNode} [node]
     * @returns {SourceNode[]}
     */
    findInvocations(macroName, node = null) {
        let target = node || this.root;
        if (!target && this.registry) {
            target = this.registry.tree ? this.registry.tree.root : null;
        }

        if (!target) {
            const source = this.registry.source || (this.context && this.context.tree && this.context.tree.source);
            // console.log(`[UPP DEBUG] findInvocations(${macroName}) no target, using registry source (${source ? source.length : 0} bytes)`);
            if (!source) return [];

            const invs = this.registry.findInvocations(source);
            return invs.filter(i => i.name === macroName).map(i => ({
                ...i,
                text: `@${i.name}(${i.args.join(',')})`,
                // Mock includes for package.hup
                includes: (str) => i.args.some(arg => arg.includes(str))
            }));
        }

        const pattern = new RegExp(`@${macroName}\\s*\\(`);
        const results = target.find(n => {
            if (n.type === 'preproc_def') return pattern.test(n.text);
            if (n.type === 'comment') {
                return n.text.startsWith('/*@') && pattern.test(n.text);
            }
            return false;
        });
        return results;
    }


    loadDependency(file) {
        this.registry.loadDependency(file, this.context.originPath, this);
    }


    /**
     * Finds the next logical node after the macro invocation.
     * @private
     */
    _getNextNode(expectedTypes = null) {
        const root = this.root || this.findRoot();
        const index = this.lastConsumedIndex || (this.invocation && this.invocation.invocationNode.endIndex);
        if (index === undefined) return null;
        return this.findNextNodeAfter(root, index);
    }

    /**
     * Retrieves the next node without removing it from the tree.
     * @param {string|string[]} [types] 
     * @returns {SourceNode|null}
     */
    nextNode(types = null) {
        const expectedTypes = typeof types === 'string' ? [types] : types;
        const node = this._getNextNode(expectedTypes);
        if (node && expectedTypes && !expectedTypes.includes(node.type)) {
            return null;
        }
        return node;
    }

    consume(expectedTypeOrOptions, errorMessage) {
        let expectedTypes = null;
        let internalErrorMessage = errorMessage;
        let validateFn = null;

        if (typeof expectedTypeOrOptions === 'string') expectedTypes = [expectedTypeOrOptions];
        else if (Array.isArray(expectedTypeOrOptions)) expectedTypes = expectedTypeOrOptions;
        else if (expectedTypeOrOptions && typeof expectedTypeOrOptions === 'object') {
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

        const node = this._getNextNode(expectedTypes);

        if (!node) {
            if (expectedTypes || validateFn) reportFailure(null);
            return null;
        }

        if (expectedTypes && !expectedTypes.includes(node.type)) reportFailure(node);
        if (validateFn && !validateFn(node)) reportFailure(node);

        const isHoisted = this.invocation && this.isDescendant(node, this.invocation.invocationNode);

        const captureText = (n) => {
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

    isDescendant(parent, node) {
        let current = node;
        const rawParent = parent ? (parent.__internal_raw_node || parent) : null;
        while (current) {
            const rawCurrent = current.__internal_raw_node || current;
            if (rawCurrent === rawParent) return true;
            current = rawCurrent.parent;
        }
        return false;
    }

    walk(node, callback) {
        if (!node) return;
        callback(node);
        const rawNode = node.__internal_raw_node || node;
        const lateBound = !!node.__isLateBound; // We might need to track this
        const sourceOverride = node.__sourceOverride; // And this

        for (let i = 0; i < rawNode.childCount; i++) {
            this.walk(this.wrapNode(rawNode.child(i), lateBound, sourceOverride), callback);
        }
    }


    parent(node) {
        return node ? node.parent : null;
    }

    childForFieldName(node, fieldName) {
        if (!node) return null;
        return node.findChildByFieldName(fieldName);
    }

    findNextNodeAfter(root, index) {
        if (!root) return null;

        const findNextSibling = (node) => {
            if (!node || !node.parent || node === root) return null;
            const idx = node.parent.children.indexOf(node);
            if (idx === -1) return null;
            for (let i = idx + 1; i < node.parent.children.length; i++) {
                const sibling = node.parent.children[i];
                if (sibling.startIndex >= index) return sibling;
            }
            return findNextSibling(node.parent);
        };

        let current = root.descendantForIndex(index, index);

        while (current && current.startIndex < index && current.endIndex > index && current.children.length > 0) {
            let nextChild = null;
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


    registerTransformRule(rule) {
        this.registry.registerTransformRule(rule);
    }

    findScope() {
        const startNode = (this.lastConsumedNode && this.lastConsumedNode.parent) ? this.lastConsumedNode : this.contextNode;
        return this.findEnclosing(startNode, ['compound_statement', 'translation_unit']);
    }

    findEnclosing(node, types) {
        if (!node) return null;
        const typeArray = Array.isArray(types) ? types : [types];
        let p = node.parent;
        while (p) {
            if (typeArray.includes(p.type)) return p;
            p = p.parent;
        }
        return null;
    }

    createUniqueIdentifier(prefix = 'v') {
        const id = uniqueIdCounter++;
        return `${prefix}_${id}`;
    }

    childCount(node) {
        return node ? node.childCount : 0;
    }

    child(node, index) {
        return node ? node.child(index) : null;
    }

    childForFieldName(node, fieldName) {
        if (!node) return null;
        return node.findChildByFieldName(fieldName);
    }

    error(node, message) {
        let finalNode = node;
        let finalMessage = message;

        if (arguments.length === 1 && typeof node === 'string') {
            finalMessage = node;
            finalNode = this.contextNode || (this.invocation && this.invocation.invocationNode);
        }

        const err = new Error(finalMessage);
        err.isUppError = true;
        err.node = finalNode;
        throw err;
    }
}

export { UppHelpersBase };
