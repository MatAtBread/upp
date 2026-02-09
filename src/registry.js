import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { UppHelpersC } from './upp_helpers_c.js';
import { DiagnosticCodes, DiagnosticsManager } from './diagnostics.js';
import Marker from './marker.js';

export const RECURSION_LIMITER_ENABLED = false;

/**
 * Main registry class for managing macros, parsing, and transformations.
 * @class
 */
class Registry {
    constructor(config = {}, parentRegistry = null) {
        this.config = config;
        this.parentRegistry = parentRegistry;
        this.macros = new Map();

        this.registerMacro('__deferred_task', ['id'], '/* handled internally */', 'js', 'internal');
        this.registerMacro('include', ['file'], `
            upp.loadDependency(file);
            let headerName = file;
            if (headerName.endsWith('.hup')) {
                headerName = headerName.slice(0, -4) + '.h';
                return \`#include "\${headerName}"\`;
            } else {
                throw new Error('Unsupported header file type: ' + file);
            }
        `, 'js', 'internal');

        this.filePath = config.filePath || '';
        this.diagnostics = config.diagnostics || new DiagnosticsManager(config);

        let lang = C;
        if (lang && lang.default) lang = lang.default;
        this.language = lang;

        this.parser = new Parser();
        this.parser.setLanguage(this.language);

        this.idCounter = 0;
        this.loadedDependencies = new Set();
        this.shouldMaterializeDependency = false;
        this.transformRules = [];
        this.ruleIdCounter = 0;
        this.deferredMarkers = [];
        this.isExecutingDeferred = false;
        this.mainContext = null;
    }

    registerMacro(name, params, body, language = 'js', origin = 'unknown', startIndex = 0) {
        this.macros.set(name, { name, params, body, language, origin, startIndex });
    }

    getMacro(name) {
        if (this.macros.has(name)) return this.macros.get(name);
        if (this.parentRegistry) return this.parentRegistry.getMacro(name);
        return undefined;
    }

    registerTransformRule(rule) {
        this.transformRules.push(rule);
        if (this.parentRegistry) {
            this.parentRegistry.registerTransformRule(rule);
        }
    }

    loadDependency(file, originPath = 'unknown', parentHelpers = null) {
        let targetPath;
        if (path.isAbsolute(file)) {
            targetPath = file;
        } else {
            const dir = (originPath && originPath !== 'unknown') ? path.dirname(originPath) : process.cwd();
            targetPath = path.resolve(dir, file);
        }

        if (this.loadedDependencies.has(targetPath)) return;
        this.loadedDependencies.add(targetPath);

        if (!fs.existsSync(targetPath)) {
            const stdPath = path.resolve(process.cwd(), 'std', file);
            if (fs.existsSync(stdPath)) {
                targetPath = stdPath;
            } else {
                throw new Error(`Dependency not found: ${file} (tried ${targetPath} and ${stdPath})`);
            }
        }

        const source = fs.readFileSync(targetPath, 'utf8');
        const output = this.transform(source, targetPath, parentHelpers);

        if (this.shouldMaterializeDependency) {
            let outputPath = null;
            if (targetPath.endsWith('.hup')) outputPath = targetPath.slice(0, -4) + '.h';
            else if (targetPath.endsWith('.cup')) outputPath = targetPath.slice(0, -4) + '.c';

            if (outputPath) {
                fs.writeFileSync(outputPath, output);
            }
        }
    }

    generateRuleId() {
        return `rule_${++this.ruleIdCounter}`;
    }

    _parse(source, oldTree) {
        if (typeof source !== 'string') return this.parser.parse("");
        const tree = this.parser.parse(source, oldTree);
        if (tree) {
             tree.sourceText = source;
        }
        if (oldTree && tree && oldTree !== tree) {
            Marker.migrate(oldTree, tree);
        }
        return tree;
    }

    applySplice(context, offset, length, replacement) {
        const oldTree = context.tree;
        context.source = Marker.splice(oldTree, context.source, offset, length, replacement);
        context.tree = this._parse(context.source, oldTree);
        Marker.migrate(oldTree, context.tree);
        context.helpers.root = context.tree.rootNode;
    }

    applyRootSplice(context, replacement) {
        this.applySplice(context, 0, context.source.length, replacement);
    }

    transform(source, originPath = 'unknown', parentHelpers = null) {
        if (!source) return "";

        const { cleanSource, invocations: foundInvs } = this.prepareSource(source, originPath);

        let tree = this._parse(cleanSource);
        if (!tree) return cleanSource;

        const context = {
            source: cleanSource,
            tree: tree,
            originPath: originPath,
            invocations: foundInvs,
            helpers: null
        };

        const helpers = new UppHelpersC(this);
        context.helpers = helpers;
        helpers.context = context;
        helpers.root = tree.rootNode;

        const isMain = !this.mainContext;
        if (isMain) {
            this.mainContext = context;
            this.deferredMarkers = [];
        }

        if (parentHelpers) {
            helpers.parentHelpers = parentHelpers;
            helpers.parentTree = parentHelpers.root;
            helpers.parentRegistry = {
                invocations: parentHelpers.context.invocations,
                sourceCode: parentHelpers.context.source,
                helpers: parentHelpers
            };
            helpers.topLevelInvocation = parentHelpers.topLevelInvocation || parentHelpers.invocation;
            helpers.currentInvocations = foundInvs.length > 0 ? foundInvs : (parentHelpers.currentInvocations || []);
        } else {
            helpers.currentInvocations = foundInvs;
        }

        this.transformNode(tree.rootNode, helpers, context);

        this.executeDeferredMarkers();

        if (isMain) {
            return this.mainContext.source;
        }

        return context.source;
    }

    transformNode(node, helpers, context) {
        if (!node) return;

        if (helpers.isConsumed(node)) {
            this.processNodeMarkers(node, helpers);
            return;
        }

        // Apply transformation rules
        const wrappedNode = helpers.wrapNode(node);
        for (const rule of this.transformRules) {
            if (rule.active && rule.nodeType === node.type) {
                try {
                    if (rule.matcher(wrappedNode, helpers)) {
                        const replacement = rule.callback(wrappedNode, helpers);
                        if (replacement !== undefined) {
                            this.applySplice(context, node.startIndex, node.endIndex - node.startIndex, replacement === null ? '' : replacement);
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`[Registry] Rule ${rule.id} matcher failed:`, err);
                }
            }
        }

        const nodeText = context.source.slice(node.startIndex, node.endIndex);

        if (node.type === 'comment' && nodeText.startsWith('/*@') && nodeText.endsWith('*/')) {
            const commentText = nodeText.slice(2, -2);
            const macroMatch = commentText.match(/^@(\w+)/);

            if (macroMatch) {
                const macroName = macroMatch[1];
                const macro = this.getMacro(macroName);

                if (macro) {
                    const inv = this.absorbInvocation(commentText, 0);
                    if (inv) {
                        const nodeMarker = new Marker(context.tree, node.startIndex);
                        const oldLength = node.endIndex - node.startIndex;

                        const result = this.evaluateMacro({
                            ...inv,
                            startIndex: node.startIndex,
                            endIndex: node.endIndex,
                            invocationNode: node
                        }, context.source, helpers, context.originPath);

                        if (result === undefined) {
                            nodeMarker.destroy();
                            return;
                        }

                        // Hoisting support: if the macro consumed an ancestor, replace THAT ancestor's range
                        let targetNode = node;
                        let p = node;
                        while (p) {
                            if (helpers.isConsumed(p)) {
                                targetNode = p;
                                break;
                            }
                            p = p.parent;
                        }

                        const currentMarker = targetNode === node ? nodeMarker : new Marker(context.tree, targetNode.startIndex);
                        const currentOldLength = targetNode.endIndex - targetNode.startIndex;

                        let finalResult = (result === null) ? "" : String(result);
                        if (finalResult.includes('@')) {
                            const nestedRegistry = new Registry(this.config, this);
                            finalResult = nestedRegistry.transform(finalResult, `result-of-@${macroName}`, helpers);
                        }

                        this.applySplice(context, currentMarker.offset, currentOldLength, finalResult);
                        currentMarker.destroy();
                        if (targetNode !== node) nodeMarker.destroy();
                        return;
                    }
                }
            }
        }

        // Visit children FORWARD
        const parentMarker = new Marker(context.tree, node.startIndex);
        for (let i = 0; i < node.childCount; i++) {
            const childCountBefore = node.childCount;
            const child = node.child(i);

            if (child) {
                this.transformNode(child, helpers, context);
            }

            const updated = parentMarker.getNode({ type: node.type });
            if (updated) {
                const delta = updated.childCount - childCountBefore;
                if (delta !== 0) {
                    i += delta;
                }
                node = updated;
            }
        }
        parentMarker.destroy();

        this.processNodeMarkers(node, helpers);
    }

    processNodeMarkers(node, helpers) {
        if (!node || this.deferredMarkers.length === 0) return;

        const remaining = [];
        const toExecute = [];

        for (const marker of this.deferredMarkers) {
            if (!marker.valid || !marker.data) {
                remaining.push(marker);
                continue;
            }

            if (marker.data.targetType === 'node' &&
                marker.offset === node.startIndex &&
                marker.data.nodeType === node.type) {
                toExecute.push(marker);
            } else {
                remaining.push(marker);
            }
        }

        if (toExecute.length === 0) return;

        this.deferredMarkers = remaining;
        for (const marker of toExecute) {
            const { callback } = marker.data;
            const targetNode = marker.getNode({ type: marker.data.nodeType });
            if (targetNode) {
                callback(targetNode, helpers);
            }
            marker.destroy();
        }
    }

    executeDeferredMarkers(specificTree = null) {
        let iterations = 0;
        const maxIterations = 100;
        this.isExecutingDeferred = true;

        try {
            while (this.deferredMarkers.length > 0 && iterations < maxIterations) {
                iterations++;

                // Only take markers that match specificTree (if provided) or all valid ones
                const current = this.deferredMarkers.filter(m => !specificTree || m.tree === specificTree);
                this.deferredMarkers = this.deferredMarkers.filter(m => specificTree && m.tree !== specificTree);

                if (current.length === 0) break;

                current.sort((a, b) => {
                    const diff = b.offset - a.offset;
                    if (diff !== 0) return diff;
                    const lenA = (a.data && a.data.nodeLength !== undefined) ? a.data.nodeLength : 0;
                    const lenB = (b.data && b.data.nodeLength !== undefined) ? b.data.nodeLength : 0;
                    return lenA - lenB;
                });

                for (const marker of current) {
                    if (!marker.valid) continue;

                    const { callback, targetType, helpers } = marker.data;
                    let targetNode = null;
                    if (targetType === 'root') {
                        targetNode = marker.tree.rootNode;
                    } else if (targetType === 'node') {
                        targetNode = marker.getNode({ type: marker.data.nodeType });
                    }

                    if (targetNode) {
                        const h = helpers || this.mainContext.helpers;
                        callback(targetNode, h);
                    }
                    marker.destroy();
                }
            }
        } finally {
            this.isExecutingDeferred = false;
        }
    }

    evaluateMacro(invocation, source, helpers, filePath) {
        const macro = this.getMacro(invocation.name);
        if (!macro) return "";

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;
        const oldActiveNode = this.activeTransformNode;

        const invocationNode = invocation.invocationNode;
        const contextNode = helpers.contextNode || invocationNode;

        helpers.invocation = { ...invocation, invocationNode };
        helpers.contextNode = contextNode;
        helpers.lastConsumedNode = null;
        this.activeTransformNode = invocationNode;

        try {
            const macroFn = this.createMacroFunction(macro);
            const args = [...invocation.args];
            let isTransformer = false;
            if (macro.params.length > 0 && macro.params[0] === 'node') {
                args.unshift(contextNode);
                isTransformer = true;
            }

            if (args.length !== macro.params.length) {
                throw new Error(`@${invocation.name} expected ${isTransformer ? macro.params.length - 1 : macro.params.length} arguments, found ${invocation.args.length}`);
            }

            return macroFn(helpers, console, ...args);
        } catch (err) {
            console.error(`Macro @${invocation.name} failed:`, err);
            this.diagnostics.reportError(0, `Macro @${invocation.name} failed: ${err.message}`, filePath, invocation.line || 1, invocation.col || 1, source);
            return undefined;
        } finally {
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
            this.activeTransformNode = oldActiveNode;
        }
    }

    createMacroFunction(macro) {
        const bodyWithReturn = (macro.language === 'js' && !macro.body.includes('return'))
            ? `return (${macro.body})`
            : macro.body;

        return new Function('upp', 'console', ...macro.params, bodyWithReturn);
    }

    prepareSource(source, originPath) {
        const definerRegex = /^\s*@define\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
        let cleanSource = source;
        let match;
        const tree = this.parser.parse(source);
        while ((match = definerRegex.exec(source)) !== null) {
            const node = tree.rootNode.descendantForIndex(match.index);
            let insideComment = false;
            let curr = node;
            while (curr) {
                if (curr.type === 'comment') { insideComment = true; break; }
                curr = curr.parent;
            }
            if (insideComment) continue;

            const name = match[1];
            const params = match[2].split(',').map(s => s.trim()).filter(Boolean);
            const bodyStart = match.index + match[0].length;
            const body = this.extractBody(source, bodyStart);
            this.registerMacro(name, params, body, 'js', originPath, match.index);

            const fullMatchLength = match[0].length + body.length + 1;
            const original = source.slice(match.index, match.index + fullMatchLength);
            const replaced = original.replace(/[^\n]/g, ' ');
            cleanSource = cleanSource.slice(0, match.index) + replaced + cleanSource.slice(match.index + fullMatchLength);
        }

        const invocations = this.findInvocations(cleanSource, tree);
        for (let i = invocations.length - 1; i >= 0; i--) {
            const inv = invocations[i];
            const original = cleanSource.slice(inv.startIndex, inv.endIndex);
            cleanSource = cleanSource.slice(0, inv.startIndex) + `/*${original}*/` + cleanSource.slice(inv.endIndex);
        }

        return { cleanSource, invocations };
    }

    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
        }
        return source.slice(startOffset, i - 1);
    }

    findInvocations(source, tree = null) {
        const invs = [];
        const regex = /@(\w+)(\s*\(([^)]*)\))?/g;
        let match;
        const currentTree = tree || this.parser.parse(source);

        while ((match = regex.exec(source)) !== null) {
            if (this.isInsideInvocation(match.index, match.index + match[0].length)) continue;

            const node = currentTree.rootNode.descendantForIndex(match.index);
            let insideComment = false;
            let curr = node;
            while (curr) {
                if (curr.type === 'comment') { insideComment = true; break; }
                curr = curr.parent;
            }
            if (insideComment) continue;

            const name = match[1].trim();
            const args = match[3] ? match[3].trim().split(',').map(s => s.trim()).filter(Boolean) : [];
            invs.push({
                name,
                args,
                startIndex: match.index,
                endIndex: match.index + match[0].length,
                line: (source.slice(0, match.index).match(/\n/g) || []).length + 1,
                col: match.index - source.lastIndexOf('\n', match.index)
            });
        }
        return invs;
    }

    absorbInvocation(text, startIndex) {
        const regex = /@(\w+)(\s*\(([^)]*)\))?/;
        const match = text.slice(startIndex).match(regex);
        if (match) {
            return {
                name: match[1],
                args: match[3]?.trim().split(',').map(s => s.trim()).filter(Boolean) || []
            };
        }
        return null;
    }

    isInsideInvocation(start, end) {
        return false;
    }
}

export { Registry };
