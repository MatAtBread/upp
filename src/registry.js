import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { UppHelpersC } from './upp_helpers_c.js';
import { UppHelpersBase } from './upp_helpers_base.js';
import { DiagnosticCodes, DiagnosticsManager } from './diagnostics.js';
import { SourceTree, SourceNode } from './source_tree.js';

export const RECURSION_LIMITER_ENABLED = false;

/**
 * Main registry class for managing macros, parsing, and transformations.
 * @class
 */
class Registry {
    constructor(config = {}, parentRegistry = null) {
        this.config = config;
        this.parentRegistry = parentRegistry;
        this.onMaterialize = config.onMaterialize || (parentRegistry ? parentRegistry.onMaterialize : null);
        this.depth = parentRegistry ? parentRegistry.depth + 1 : 0;
        if (this.depth > 100) {
            throw new Error(`Maximum macro nesting depth exceeded (${this.depth})`);
        }

        this.filePath = config.filePath || '';
        this.diagnostics = config.diagnostics || new DiagnosticsManager(config);

        let lang = C;
        if (lang && lang.default) lang = lang.default;
        this.language = lang;

        this.helpers = null;
        this.parentHelpers = parentRegistry ? (parentRegistry.helpers || new UppHelpersBase(null, parentRegistry, null)) : null;
        this.parentTree = parentRegistry ? parentRegistry.tree : null;

        this.macros = new Map();

        this.registerMacro('__deferred_task', ['id'], '/* handled internally */', 'js', 'internal');
        this.registerMacro('implements', ['pkgName'], '', 'js', 'internal');
        this.registerMacro('include', ['file'], `
            upp.loadDependency(file, null, upp);
            let headerName = file;
            if (headerName.endsWith('.hup')) {
                headerName = headerName.slice(0, -4) + '.h';
                const stdDir = upp.stdPath || "";
                const parentDir = upp.path.dirname(upp.registry.originPath || "");
                if (stdDir && parentDir && file.includes('package.hup')) {
                    headerName = upp.path.relative(parentDir, upp.path.join(stdDir, 'package.h'));
                }
                return \`#include "\${headerName}"\`;
            } else {
                throw new Error('Unsupported header file type: ' + file);
            }
        `, 'js', 'internal');

        this.parser = new Parser();
        this.parser.setLanguage(this.language);

        this.idCounter = 0;
        this.stdPath = config.stdPath || null;
        this.loadedDependencies = parentRegistry ? parentRegistry.loadedDependencies : new Map();
        this.shouldMaterializeDependency = false;
        this.transformRules = [];
        this.ruleIdCounter = 0;
        this.isExecutingDeferred = false;
        this.onMaterialize = config.onMaterialize || null;
        this.mainContext = parentRegistry ? parentRegistry.mainContext : null;
        this.UppHelpersC = UppHelpersC; // Ensure this is available
    }

    registerMacro(name, params, body, language = 'js', origin = 'unknown', startIndex = 0) {
        this.macros.set(name, { name, params, body, language, origin, startIndex });
        if (this.parentRegistry) {
            this.parentRegistry.registerMacro(name, params, body, language, origin, startIndex);
        }
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

        const isDiscoveryOnly = parentHelpers === null;
        const previousPass = this.loadedDependencies.get(targetPath);

        if (previousPass === 'full') return;
        if (isDiscoveryOnly && previousPass === 'discovery') return;

        if (!fs.existsSync(targetPath)) {
            const stdPath = path.resolve(process.cwd(), 'std', file);
            if (fs.existsSync(stdPath)) {
                targetPath = stdPath;
            } else {
                throw new Error(`Dependency not found: ${file} (tried ${targetPath} and ${stdPath})`);
            }
        }

        this.loadedDependencies.set(targetPath, isDiscoveryOnly ? 'discovery' : 'full');

        const source = fs.readFileSync(targetPath, 'utf8');
        const depRegistry = new Registry(this.config, this);
        depRegistry.shouldMaterializeDependency = true;

        if (isDiscoveryOnly) {
            depRegistry.source = source;
            depRegistry.prepareSource(source, targetPath);
        } else {
            const output = depRegistry.transform(source, targetPath, parentHelpers);

            if (depRegistry.shouldMaterializeDependency) {
                let outputPath = null;
                if (targetPath.endsWith('.hup')) outputPath = targetPath.slice(0, -4) + '.h';
                else if (targetPath.endsWith('.cup')) outputPath = targetPath.slice(0, -4) + '.c';

                if (outputPath) {
                    if (this.onMaterialize) {
                        this.onMaterialize(outputPath, output);
                    } else {
                        fs.writeFileSync(outputPath, output);
                    }
                }
            }
        }
    }

    generateRuleId() {
        return `rule_${++this.ruleIdCounter}`;
    }


    transform(source, originPath = 'unknown', parentHelpers = null) {
        this.source = source;
        if (!source) return "";

        // Initialize tree as early as possible so dependencies can see us
        this.tree = new SourceTree(source, this.language);
        this.helpers = new this.UppHelpersC(this.tree.root, this, parentHelpers);

        const { cleanSource, invocations: foundInvs } = this.prepareSource(source, originPath);

        // Update tree with clean source if it changed
        if (cleanSource !== source) {
            this.tree = new SourceTree(cleanSource, this.language);
            this.helpers.root = this.tree.root; // Update helpers root
        }
        const sourceTree = this.tree;

        const context = {
            source: cleanSource, // This will be stale, should use sourceTree.source
            tree: sourceTree,
            originPath: originPath,
            invocations: foundInvs,
            helpers: null
        };

        const helpers = new this.UppHelpersC(sourceTree.root, this, parentHelpers);
        context.helpers = helpers;
        helpers.context = context;
        helpers.root = sourceTree.root;

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
                sourceCode: (parentHelpers.context.tree && parentHelpers.context.tree.source) || parentHelpers.context.source,
                helpers: parentHelpers
            };
            helpers.topLevelInvocation = parentHelpers.topLevelInvocation || parentHelpers.invocation;
            helpers.currentInvocations = foundInvs.length > 0 ? foundInvs : (parentHelpers.currentInvocations || []);
        } else {
            helpers.currentInvocations = foundInvs;
        }

        this.transformNode(sourceTree.root, helpers, context);

        this.executeDeferredMarkers(helpers);

        return sourceTree.source;
    }

    transformNode(node, helpers, context) {
        if (!node) return;

        // Skip invalidated nodes
        if (node.startIndex === -1) return;

        // 1. Check for attached markers/callbacks (Deferred transformations)
        const markers = [...node.markers];
        node.markers = []; // Clear so we don't re-run
        for (const marker of markers) {
            try {
                const result = marker.callback(node, helpers);
                if (result !== undefined) {
                    helpers.replace(node, result);
                }
            } catch (e) {
                console.error(`Marker callback failed on ${node.type}:`, e);
            }
        }

        // Re-check validity after markers (node might have been replaced)
        if (node.startIndex === -1) return;

        // 2. Check for Macro Invocation (wrapped in comments by prepareSource)
        if (node.type === 'comment') {
            const nodeText = node.text;
            if (nodeText.startsWith('/*@') && nodeText.endsWith('*/')) {
                const commentText = nodeText.slice(2, -2);
                const inv = this.absorbInvocation(commentText, 0);
                if (inv) {
                    const result = this.evaluateMacro({
                        ...inv,
                        startIndex: node.startIndex,
                        endIndex: node.endIndex,
                        invocationNode: node
                    }, context.tree.source, helpers, context.originPath);

                    if (result !== undefined) {
                        let finalResult = (result === null) ? "" : String(result);
                        console.log(`[DEBUG] Macro @${inv.name} at ${node.startIndex}-${node.endIndex} result:`, finalResult);

                        // Pre-process the result to wrap nested macros in comments (like prepareSource does)
                        // otherwise they will be parsed as invalid syntax or identifiers
                        if (finalResult.includes('@')) {
                            const prepared = this.prepareSource(finalResult, context.originPath);
                            finalResult = prepared.cleanSource;
                        }

                        const newNodes = helpers.replace(node, finalResult);

                        // Recursively transform any new nodes in the current context
                        if (Array.isArray(newNodes)) {
                            for (const newNode of newNodes) {
                                this.transformNode(newNode, helpers, context);
                            }
                        } else if (newNodes) {
                            this.transformNode(newNodes, helpers, context);
                        }
                    }
                    return; // Macro handles its own text/children
                }
            }
        }

        for (const rule of this.transformRules) {
            if (rule.active) {
                try {
                    if (rule.matcher(node, helpers)) {
                        const result = rule.callback(node, helpers);
                        if (result !== undefined) {
                            helpers.replace(node, result);
                        }
                        if (node.startIndex === -1) return;
                    }
                } catch (e) {
                    // rule failed
                }
            }
        }

        // 4. Recursive Stable Walk
        // NOTE: We snapshot children because transformations might add/remove nodes
        const children = [...node.children];
        for (const child of children) {
            this.transformNode(child, helpers, context);
        }
    }


    executeDeferredMarkers(helpers) {
        if (this.isExecutingDeferred) return;
        this.isExecutingDeferred = true;

        try {
            let iterations = 0;
            const MAX_ITERATIONS = 100;

            while (iterations < MAX_ITERATIONS) {
                // Find all nodes that have pending markers
                const nodesWithMarkers = this.tree.root.find(n => n.markers.length > 0 && n.startIndex !== -1);
                console.log(`[DEBUG] executeDeferredMarkers: found ${nodesWithMarkers.length} nodes with markers`);
                if (nodesWithMarkers.length === 0) break;

                iterations++;
                for (const node of nodesWithMarkers) {
                    console.log(`[DEBUG] executeDeferredMarkers: executing markers on ${node.type} at ${node.startIndex}`);
                }

                // Sort bottom-up and right-to-left for predictable execution
                nodesWithMarkers.sort((a, b) => {
                    if (b.startIndex !== a.startIndex) return b.startIndex - a.startIndex;
                    return b.endIndex - a.endIndex;
                });

                for (const node of nodesWithMarkers) {
                    if (node.startIndex === -1) continue; // Skip if already invalidated

                    const markers = [...node.markers];
                    node.markers = [];
                    for (const marker of markers) {
                        try {
                            const result = marker.callback(node, helpers);
                            if (result !== undefined) {
                                helpers.replace(node, result);
                            }
                            if (node.startIndex === -1) break; // Node replaced, stop running markers on it
                        } catch (e) {
                            console.error(`Deferred marker failed on ${node.type}:`, e);
                        }
                    }
                }
            }
            if (iterations === MAX_ITERATIONS) {
                console.warn("MAX_ITERATIONS reached in executeDeferredMarkers (possible infinite marker loop)");
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

            const upp = Object.create(helpers);
            upp.registry = this;
            upp.parentHelpers = this.parentHelpers;
            upp.path = path;
            upp.invocation = { ...invocation, invocationNode };

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

            return macroFn(upp, console, ...args);
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
        const body = macro.body.trim();
        // Avoid wrapping empty or comment-only macros in 'return ()' which is invalid syntax
        const shouldWrap = macro.language === 'js' &&
            body.length > 0 &&
            !body.startsWith('//') &&
            !body.startsWith('/*') &&
            !body.includes('return');

        const finalBody = shouldWrap && !body.includes(';') && !body.includes('\n') ? `return (${body})` : body;

        try {
            return new Function('upp', 'console', ...macro.params, finalBody);
        } catch (e) {
            console.log("SYNTAX ERROR IN MACRO", macro.name);
            console.log("FINAL BODY:\n", finalBody);
            throw e;
        }
    }

    prepareSource(source, originPath) {
        const definerRegex = /^\s*@define\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
        let cleanSource = source;
        let match;
        const tree = this.parser.parse(source);
        while ((match = definerRegex.exec(source)) !== null) {
            const node = tree.rootNode.descendantForIndex(match.index);
            let shouldSkip = false;
            let curr = node;
            const skipTypes = ['comment', 'string_literal', 'system_lib_string', 'char_literal'];
            while (curr) {
                if (skipTypes.includes(curr.type)) { shouldSkip = true; break; }
                curr = curr.parent;
            }
            if (shouldSkip) continue;

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
                // Handle @include immediately for dependency discovery
                const file = inv.args[0];
                if (file) {
                    let filename = file;
                    if ((filename.startsWith('"') && filename.endsWith('"')) || (filename.startsWith("'") && filename.endsWith("'"))) {
                        filename = filename.slice(1, -1);
                    }
                    this.loadDependency(filename, originPath);
                }
            }
            // Wrap ALL macros in comments so transformNode can find and execute them
            cleanSource = cleanSource.slice(0, inv.startIndex) + `/*${original}*/` + cleanSource.slice(inv.endIndex);
        }

        return { cleanSource, invocations };
    }

    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        let inString = null;
        let inComment = null; // 'line' or 'block'
        let escaped = false;

        while (i < source.length && depth > 0) {
            const char = source[i];
            const nextChar = source[i + 1];

            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (inComment === 'line') {
                if (char === '\n') inComment = null;
            } else if (inComment === 'block') {
                if (char === '*' && nextChar === '/') {
                    inComment = null;
                    i++;
                }
            } else if (inString) {
                if (char === inString) inString = null;
            } else {
                if (char === '/' && nextChar === '/') {
                    inComment = 'line';
                    i++;
                } else if (char === '/' && nextChar === '*') {
                    inComment = 'block';
                    i++;
                } else if (char === "'" || char === '"' || char === '`') {
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
        const regex = /(?<![\/*])@(\w+)(\s*\(([^)]*)\))?/g;
        let match;
        const currentTree = tree || this.parser.parse(source);

        while ((match = regex.exec(source)) !== null) {
            if (this.isInsideInvocation(match.index, match.index + match[0].length)) continue;

            const node = currentTree.rootNode.descendantForIndex(match.index);
            let shouldSkip = false;
            let curr = node;
            const skipTypes = ['comment', 'string_literal', 'system_lib_string', 'char_literal'];
            while (curr) {
                if (skipTypes.includes(curr.type)) { shouldSkip = true; break; }
                curr = curr.parent;
            }
            if (shouldSkip) continue;

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
