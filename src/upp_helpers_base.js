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
        return "";
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
        return this.context.tree ? this.wrapNode(this.context.tree.rootNode) : this.root;
    }

    findParent(node) {
        return this.parent(node);
    }

    findScope(node) {
        return this.enclosingScope(node || this.contextNode);
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
        let node = null;
        let anchor = this.lastConsumedNode || (this.invocation && this.invocation.invocationNode) || this.contextNode;

        if (anchor && anchor.parent) {
            // Priority 1: Check siblings
            const idx = anchor.parent.children.indexOf(anchor);
            if (idx !== -1 && idx + 1 < anchor.parent.children.length) {
                node = anchor.parent.children[idx + 1];
            }

            // Priority 2: Check parent (embedded macro case, e.g. @attribute in a struct)
            // But only if no sibling found, and anchor is NOT a comment (tokens are never parents of their context)
            if (!node && anchor.type !== 'comment' && expectedTypes && expectedTypes.includes(anchor.parent.type)) {
                node = anchor.parent;
            }
        }

        if (!node && this.contextNode) {
            // Check descendants if not found as sibling
            for (const child of this.contextNode.children) {
                if (!expectedTypes || expectedTypes.includes(child.type)) {
                    node = child;
                    break;
                }
            }
        }
        return node;
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

        const text = node.text;
        const wrapped = node;
        // We could store the text on the node object itself if needed, 
        // but for now we just return the node which still has correct indices 
        // if we are careful, or we can add a 'capturedText' property.
        node._capturedText = text;

        if (!isHoisted) {
            this.replace(node, "");
        }
        this.consumedIds.add(node.id);
        this.lastConsumedNode = node;
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
        // Search in children for one that matches fieldName if we had that, 
        // but SourceNode doesn't keep field names yet.
        // For now, look at the type/structure or use a fallback.
        // TODO: Map fieldNames in SourceNode wrapper.
        return null;
    }

    findNextNodeAfter(root, index) {
        if (!root) return null;
        let node = root.descendantForIndex(index, index);
        const rawRoot = root.__internal_raw_node || root;

        while (node && node.endIndex <= index) {
            const rawNode = node.__internal_raw_node || node;
            if (rawNode.nextNamedSibling) { node = rawNode.nextNamedSibling; break; }
            node = rawNode.parent;
            if (!node || (node.__internal_raw_node || node) === rawRoot) break;
        }
        if (!node) return null;

        while (node && node.startIndex < index) {
            let nextChild = null;
            for (let i = 0; i < node.namedChildCount; i++) {
                const c = node.namedChild(i);
                if (c.endIndex > index) { nextChild = c; break; }
            }
            if (nextChild) node = nextChild;
            else break;
        }

        let current = node;
        while (current.parent && current.parent.startIndex >= index && current.parent.type !== 'translation_unit') {
            current = current.parent;
        }
        node = current;

        const finalNode = node && node.isNamed ? node : (node ? node.nextNamedSibling : null);
        return (finalNode && finalNode.type !== 'translation_unit') ? finalNode : null;
    }

    enclosingScope(node) {
        let p = node ? node.parent : null;
        while (p) {
            if (['compound_statement', 'function_definition', 'translation_unit'].includes(p.type)) return p;
            p = p.parent;
        }
        return this.findRoot();
    }

    registerTransformRule(rule) {
        this.registry.registerTransformRule(rule);
    }

    error(node, message) {
        const err = new Error(message);
        err.isUppError = true;
        err.node = node;
        throw err;
    }
}

export { UppHelpersBase };
