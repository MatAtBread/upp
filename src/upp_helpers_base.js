import Parser, { SyntaxNode, Query } from 'tree-sitter';
import path from 'path';
import fs from 'fs';
import Marker from './marker.js';

/**
 * Base helper class providing general-purpose macro utilities.
 * @class
 */
class UppHelpersBase {
    constructor(registry) {
        this.registry = registry;
        this.root = null;
        this.contextNode = null;
        this.invocation = null;
        this.lastConsumedNode = null;
        this.isDeferred = false;
        this.nodeCache = new Map();
        this.currentInvocations = [];
        this.consumedIds = new Set();
        this.context = null; // Back-reference to the local transform context
    }

    atRoot(callback) {
        const root = this.findRoot();
        if (!root) return "";
        return this.withNode(root, callback);
    }

    inScope(callback) {
        const scope = this.findScope();
        if (!scope) return "";
        return this.withNode(scope, callback);
    }

    replace(n, newContent) {
        const contentStr = typeof newContent === 'object' ? newContent.text : String(newContent);
        const isRoot = n.type === 'translation_unit' || n.parent === null;

        const startMarker = n.__marker_bound ? n.__marker_bound : new Marker(this.context.tree, n.startIndex);
        const endMarker = new Marker(this.context.tree, n.endIndex);

        if (this.registry.isExecutingDeferred) {
            const len = endMarker.offset - startMarker.offset;
            if (isRoot) {
                this.registry.applyRootSplice(this.context, contentStr);
            } else {
                this.registry.applySplice(this.context, startMarker.offset, len, contentStr);
            }
            if (!n.__marker_bound) startMarker.destroy();
            endMarker.destroy();
            return "";
        }

        const marker = new Marker(this.context.tree, startMarker.offset, {
            callback: (target, helpers) => {
                const len = endMarker.offset - startMarker.offset;
                if (isRoot) {
                    helpers.registry.applyRootSplice(helpers.context, contentStr);
                } else {
                    helpers.registry.applySplice(helpers.context, startMarker.offset, len, contentStr);
                }
                if (!n.__marker_bound) startMarker.destroy();
                endMarker.destroy();
            },
            targetType: isRoot ? 'root' : 'node',
            nodeType: n.type,
            nodeLength: n.endIndex - n.startIndex,
            helpers: this
        });
        this.registry.deferredMarkers.push(marker);
        return "";
    }

    query(queryString, node = null) {
        const target = node ? (node.__internal_raw_node || node) : this.root;
        const query = new Query(this.registry.language, queryString);
        const matches = query.matches(target);

        return matches.map(m => {
            const captures = {};
            for (const c of m.captures) {
                captures[c.name] = this.wrapNode(c.node);
            }
            return captures;
        });
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

        const isDescendant = this.registry.activeTransformNode && this.isDescendant(this.registry.activeTransformNode, node);
        const isMarkerAware = !!node.__marker_bound;

        if (isDescendant || this.registry.isExecutingDeferred || isMarkerAware) {
            const wrapped = this.wrapNode(node, this.registry.isExecutingDeferred);
            const result = callback(wrapped, this);
            if (result !== undefined) {
                const start = node.__marker_bound ? node.__marker_bound.offset : node.startIndex;
                const end = node.endIndex;
                const len = node.__marker_bound ? 0 : (end - start);

                this.registry.applySplice(this.context, start, len, result === null ? "" : String(result));
            }
            return "";
        }

        const preservedText = node.text;
        const marker = new Marker(this.context.tree, node.startIndex, {
            callback: (target, helpers) => {
                const wrapped = helpers.wrapNode(target, true, preservedText);
                const result = callback(wrapped, helpers);
                if (result !== undefined) {
                    helpers.replace(target, result === null ? "" : String(result));
                }
            },
            targetType: 'node',
            nodeType: node.type,
            nodeLength: node.endIndex - node.startIndex,
            helpers: this
        });
        this.registry.deferredMarkers.push(marker);
        return preservedText;
    }

    wrapNode(node, lateBound = false, sourceOverride = null, treeOverride = null) {
        if (!node || node.__isWrapped) return node;
        const helpers = this;

        const treeSource = sourceOverride || (node.tree && node.tree.sourceText) || helpers.context.source;
        const currentTree = treeOverride || node.tree || helpers.context.tree;
        const capturedText = lateBound ? null : treeSource.slice(node.startIndex, node.endIndex);

        const proxy = new Proxy(node, {
            get(target, prop) {
                if (prop === '__isWrapped') return true;
                if (prop === '__internal_raw_node') return target;
                if (prop === '__isLateBound') return lateBound;
                if (prop === '__sourceOverride') return treeSource;
                if (prop === '__treeOverride') return currentTree;
                if (prop === 'startIndex') {
                    if (lateBound && target.__marker_bound) return target.__marker_bound.offset;
                    return target.startIndex;
                }
                if (prop === 'endIndex') {
                    if (lateBound && target.__marker_bound_end) return target.__marker_bound_end.offset;
                    return target.endIndex;
                }
                if (prop === 'text') {
                    if (lateBound) {
                        return helpers.context.source.slice(helpers.getLiveOffset(target, 'start'), helpers.getLiveOffset(target, 'end'));
                    }
                    return capturedText;
                }
                if (prop === 'childForFieldName') {
                    return (fieldName) => {
                        const child = target.childForFieldName(fieldName);
                        return child ? helpers.wrapNode(child, lateBound, treeSource, currentTree) : null;
                    };
                }
                const value = Reflect.get(target, prop);
                if (typeof value === 'function') {
                    return (...args) => {
                        let result = value.apply(target, args);
                        if (result && typeof result === 'object' && result.type) {
                             return helpers.wrapNode(result, lateBound, treeSource);
                        }
                        return result;
                    };
                }
                if (value && typeof value === 'object' && value.type) {
                    return helpers.wrapNode(value, lateBound, treeSource);
                }
                return value;
            }
        });
        return proxy;
    }

    isConsumed(node) {
        if (!node) return false;
        return this.consumedIds.has(node.id);
    }

    loadDependency(file) {
        this.registry.loadDependency(file, this.context.originPath);
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

        let node = null;
        let anchor = this.lastConsumedNode || this.contextNode;
        if (anchor) {
            let rootForSearch = this.context.tree.rootNode;
            let searchIdx = anchor.endIndex;

            if (this.invocation && (anchor.id === this.invocation.id || anchor.type === 'macro_invocation')) {
                 searchIdx = anchor.endIndex;
            } else if (this.invocation && anchor.startIndex <= this.invocation.startIndex && anchor.endIndex >= this.invocation.endIndex) {
                 searchIdx = this.invocation.endIndex;
            }

            node = this.findNextNodeAfter(rootForSearch, searchIdx);
        } else if (this.invocation) {
            let rootForSearch = this.context.tree.rootNode;
            node = this.findNextNodeAfter(rootForSearch, (this.topLevelInvocation || this.invocation).endIndex);
        }

        if (node && expectedTypes && !expectedTypes.includes(node.type)) {
            // Found a sibling but it doesn't match. Are we nested?
            let p = this.contextNode ? (this.contextNode.__internal_raw_node || this.contextNode) : null;
            while (p) {
                if (expectedTypes.includes(p.type)) {
                    node = p;
                    break;
                }
                p = p.parent;
            }
        }

        if (!node) {
            // Traditional nested check if nothing was found after anchor
            let p = this.contextNode ? (this.contextNode.__internal_raw_node || this.contextNode) : null;
            while (p) {
                if (expectedTypes && expectedTypes.includes(p.type)) {
                    node = p;
                    break;
                }
                p = p.parent;
            }

            if (!node) {
                if (expectedTypes || validateFn) reportFailure(null);
                return null;
            }
        }

        while (node.parent && node.parent.startIndex === node.startIndex && node.parent.type !== 'translation_unit') node = node.parent;
        if (expectedTypes && !expectedTypes.includes(node.type)) reportFailure(node);
        if (validateFn && !validateFn(node)) reportFailure(node);

        // Capture markers BEFORE deletion so they track the correct spot
        const marker = new Marker(this.context.tree, node.startIndex);
        const markerEnd = new Marker(this.context.tree, node.endIndex);
        node.__marker_bound = marker;
        node.__marker_bound_end = markerEnd;

        const wrapped = this.wrapNode(node, true);
        const isHoisted = this.invocation && this.isDescendant(node, this.invocation.invocationNode);

        // Perform immediate deletion (unless we're hoisting, in which case the macro result will replace the range)
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
        try { return this.wrapNode(node ? (node.__internal_raw_node || node).parent : null); }
        catch (e) { return null; }
    }

    childForFieldName(node, fieldName) {
        if (!node) return null;
        const rawNode = node.__internal_raw_node || node;
        try {
            const child = rawNode.childForFieldName(fieldName);
            return child ? this.wrapNode(child) : null;
        } catch (e) { return null; }
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
        let p = node ? (node.__internal_raw_node || node).parent : null;
        while (p) {
            if (['compound_statement', 'function_definition', 'translation_unit'].includes(p.type)) return this.wrapNode(p);
            p = p.parent;
        }
        return this.findRoot();
    }

    error(node, message) {
        const err = new Error(message);
        err.isUppError = true;
        err.node = node;
        throw err;
    }
}

export { UppHelpersBase };
