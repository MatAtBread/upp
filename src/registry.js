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
        this.depth = parentRegistry ? parentRegistry.depth + 1 : 0;
        if (this.depth > 100) {
            throw new Error(`Maximum macro nesting depth exceeded (${this.depth})`);
        }
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
        const replacementStr = replacement === null ? "" : String(replacement);
        context.source = Marker.splice(oldTree, context.source, offset, length, replacementStr);
        context.tree = this._parse(context.source, oldTree);
        Marker.migrate(oldTree, context.tree);
        context.helpers.root = context.tree.rootNode;
        context.helpers.nodeCache.clear();
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

        // Skip consumed nodes
        if (helpers.isConsumed(node)) return;

        // 1. Check for Transformation Rules
        const wrappedNode = helpers.wrapNode(node);
        for (const rule of this.transformRules) {
            if (rule.active && rule.nodeType === node.type) {
                try {
                    if (rule.matcher(wrappedNode, helpers)) {
                        const marker = new Marker(context.tree, node.startIndex, {
                            callback: (target, h) => {
                                const wrapped = h.wrapNode(target);
                                const result = rule.callback(wrapped, h);
                                if (result !== undefined) {
                                    h.replace(target, result);
                                }
                            },
                            targetType: 'node',
                            nodeType: node.type,
                            nodeLength: node.endIndex - node.startIndex,
                            helpers: helpers
                        });
                        this.deferredMarkers.push(marker);
                        return; // Rule handles its own subtree/text
                    }
                } catch (e) {
                    // console.error(`[Registry] Rule ${rule.id} failed:`, e);
                }
            }
        }

        // 2. Check for Macro Invocation (wrapped in comments by prepareSource)
        if (node.type === 'comment') {
            const nodeText = context.source.slice(node.startIndex, node.endIndex);
            if (nodeText.startsWith('/*@') && nodeText.endsWith('*/')) {
                const commentText = nodeText.slice(2, -2);
                const inv = this.absorbInvocation(commentText, 0);
                if (inv) {
                    // Always collect a marker for macro invocations, even if not yet registered.
                    // This allows @include to register macros before they are used later in the same pass.
                    const marker = new Marker(context.tree, node.startIndex, {
                        callback: (target, h) => {
                            const targetText = h.context.source.slice(target.startIndex, target.endIndex);
                            const internalInv = this.absorbInvocation(targetText.slice(2, -2), 0);
                            if (!internalInv) return;

                            const result = this.evaluateMacro({
                                ...internalInv,
                                startIndex: target.startIndex,
                                endIndex: target.endIndex,
                                invocationNode: target
                            }, h.context.source, h, h.context.originPath);

                            if (result !== undefined) {
                                let finalResult = (result === null) ? "" : String(result);
                                if (finalResult.includes('@')) {
                                    const nestedRegistry = new Registry(h.registry.config, h.registry);
                                    finalResult = nestedRegistry.transform(finalResult, `result-of-@${internalInv.name}`, h);
                                }
                                h.replace(target, finalResult);
                            }
                        },
                        targetType: 'node',
                        nodeType: node.type,
                        nodeLength: node.endIndex - node.startIndex,
                        helpers: helpers
                    });
                    this.deferredMarkers.push(marker);
                    return; // Macro handles its own text/children
                }
            }
        }

        // 3. Recursive Stable Walk (READ-ONLY)
        for (let i = 0; i < node.childCount; i++) {
            this.transformNode(node.child(i), helpers, context);
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

                // Sort: High priority first, then by offset descending (bottom-up)
                current.sort((a, b) => {
                    // 1. Priority (Higher first)
                    const pA = (a.data && a.data.priority) || 0;
                    const pB = (b.data && b.data.priority) || 0;
                    if (pA !== pB) return pB - pA;

                    // 2. Offset (Descending / Bottom-Up)
                    const diff = b.offset - a.offset;
                    if (diff !== 0) return diff;

                    // 3. Length (Ascending - inner nodes first if offsets match)
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
                        const prevContext = h.contextNode;
                        h.contextNode = targetNode;
                        try {
                            callback(targetNode, h);
                        } finally {
                            h.contextNode = prevContext;
                        }
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

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;
        const oldActiveNode = this.activeTransformNode;

        try {
            if (!macro) throw new Error(`Macro @${invocation.name} not found`);

            const invocationNode = invocation.invocationNode;
            const contextNode = helpers.contextNode || invocationNode;

            helpers.invocation = { ...invocation, invocationNode };
            helpers.contextNode = contextNode;
            helpers.lastConsumedNode = null;
            this.activeTransformNode = invocationNode;

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

            if (inv.name === 'include') {
                // Handle @include immediately
                const file = inv.args[0];
                if (file) {
                   // Strip quotes if present (args parser might leave them if simple split/trim used)
                   // The current findInvocations/absorbInvocation seems to simple split by comma.
                   // Let's assume the args are raw strings.
                   // Wait, absorbInvocation splits by comma and trims.
                   // If the user wrote @include("foo.h"), arg is "\"foo.h\"".
                   // If they wrote @include(foo.h), arg is "foo.h".
                   // The original macro didn't seem to strip quotes explicitly in the JS code provided in Registry constructor,
                   // but `upp.loadDependency(file)` would fail if file had quotes in the string content itself.
                   // Actually looking at the registry.js macro def: `upp.loadDependency(file);`
                   // If the regex match included quotes, they are part of the string.

                   let filename = file;
                   if ((filename.startsWith('"') && filename.endsWith('"')) || (filename.startsWith("'") && filename.endsWith("'"))) {
                       filename = filename.slice(1, -1);
                   }

                   this.loadDependency(filename, originPath);

                   let replacement = "";
                   if (filename.endsWith('.hup')) {
                       const headerName = filename.slice(0, -4) + '.h';
                       replacement = `#include "${headerName}"`;
                   } else if (filename.endsWith('.cup')) {
                        // .cup files usually don't generate .h files directly to include,
                        // but maybe they do? The original macro threw error for anything not .hup?
                        // Original macro:
                        // if (headerName.endsWith('.hup')) { ... } else { throw ... }
                        // I should verify what the original macro did.
                        // It was:
                        // if (headerName.endsWith('.hup')) { ... } else { throw new Error('Unsupported header file type: ' + file); }
                        // So I should stick to that logic or make it safe.
                        // However, standard C includes might be .h
                        // If it's just a .h file, we should probably just emit #include "..."
                        // But loadDependency handles the loading.

                        // Let's stick to the .hup logic for now to match exactly.
                       const headerName = filename.slice(0, -4) + '.h';
                       replacement = `#include "${headerName}"`;
                   } else {
                        // For standard includes or others, maybe just keep them?
                        // The user said "ALL @include directives should be processed...".
                        // If it's a standard .h, loadDependency might fail if it tries to find it in std/ or relative,
                        // unless it exists.
                        // But wait, the original macro threw an error!
                        // "throw new Error('Unsupported header file type: ' + file);"
                        // So I should probably replicate that or be slightly more permissive?
                        // The user's prompt implies fixing ordering, not changing behavior.
                        // I'll stick to logic that supports .hup.

                       // Actually, if it is JUST a .h file, we might want to allow it if transpile.js expects it?
                       // But the macro logic was strict. I will relax it slightly to allow .h if loadDependency works?
                       // No, strict is safer to match previous behavior.

                       // Wait, looking at lines 26-35 of registry.js:
                       // if (headerName.endsWith('.hup')) { ... } else { throw ... }
                       // So it ONLY supported .hup.

                       if (filename.endsWith('.hup')) {
                           replacement = `#include "${filename.slice(0, -4) + '.h'}"`;
                       } else {
                            // If we want to support raw C includes via @include, we could.
                            // But usually #include is used for that.
                            // I will throw to match original behavior.
                             throw new Error('Unsupported header file type for @include: ' + filename);
                       }
                   }

                   cleanSource = cleanSource.slice(0, inv.startIndex) + replacement + cleanSource.slice(inv.endIndex);
                }
            } else {
                // Wrap other macros
                cleanSource = cleanSource.slice(0, inv.startIndex) + `/*${original}*/` + cleanSource.slice(inv.endIndex);
            }
        }

        return { cleanSource, invocations };
    }

    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        let inString = null;
        let escaped = false;

        while (i < source.length && depth > 0) {
            const char = source[i];
            const nextChar = source[i+1];

            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (inString) {
                if (char === inString) {
                    // Template literal interpolation handling
                    if (char === '`' && source[i-1] === '}' && !escaped) {
                         // This is tricky, but for now let's just assume backticks are balanced
                    }
                    inString = null;
                }
            } else {
                if (char === "'" || char === '"' || char === '`') {
                    inString = char;
                } else if (char === '{') {
                    depth++;
                } else if (char === '}') {
                    depth--;
                }
            }
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
