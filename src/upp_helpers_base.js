import path from 'path';
import fs from 'fs';

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    constructor(root, registry, parentHelpers = null) {
        this.root = root;
        this.registry = registry;
        this.parentHelpers = parentHelpers;
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

    code(strings, ...values) {
        let result = "";
        for (let i = 0; i < strings.length; i++) {
            result += strings[i];
            if (i < values.length) {
                const val = values[i];
                result += (val && typeof val === 'object' && val.text !== undefined) ? val.text : String(val);
            }
        }
        return result;
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

    replace(n, newContent) {
        if (!n) return "";
        const result = n.replaceWith(newContent);
        // If we replaced 'this.contextNode', update it for the helper?
        // Actually Registry handles the walk, but helpers.contextNode might need update.
        if (this.contextNode === n) this.contextNode = result;
        return result;
    }

    query(queryString, node = null) {
        let target = node || this.root;
        if (!target && this.registry) {
            target = this.registry.tree ? this.registry.tree.root : null;
        }

        // Simple type-based or functional query fallback if queryString is just a type
        if (target && !queryString.includes('(')) {
            return target.find(queryString).map(n => ({ node: n, captures: { node: n } }));
        }

        if (!target) return [];

        // For complex S-expressions, we'd need a stable matcher.
        // For Milestone 1, we'll stick to simple finds or implement a basic matcher.
        throw new Error("Complex S-expression queries not yet supported on stable SourceTree");
    }

    findRoot() {
        return (this.context && this.context.tree) ? this.wrapNode(this.context.tree.rootNode) : this.root;
    }

    findParent(node) {
        return this.parent(node);
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

    isConsumed(node) {
        if (!node) return false;
        return this.consumedIds.has(node.id);
    }

    loadDependency(file) {
        this.registry.loadDependency(file, this.context.originPath, this);
    }

    registerParentTransform(callback) {
        if (!this.parentHelpers) {
            console.warn("registerParentTransform called without a parent context");
            return;
        }
        // Simplified: just run it on the parent's root node now
        callback(this.parentTree, this.parentHelpers);
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
            this.replace(node, "");
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

    getLiveOffset(node, type = 'start') {
        const raw = node.__internal_raw_node || node;
        if (type === 'start') {
            return raw.__marker_bound ? raw.__marker_bound.offset : raw.startIndex;
        } else {
            return raw.__marker_bound_end ? raw.__marker_bound_end.offset : raw.endIndex;
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
        return this.findEnclosing(this.lastConsumedNode || this.contextNode, ['compound_statement', 'translation_unit']);
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
        const id = Math.random().toString(36).slice(2, 8);
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
