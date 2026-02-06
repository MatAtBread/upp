import Parser from 'tree-sitter';
const { Query, SyntaxNode } = Parser;

// Ensure SyntaxNode has a robust .text getter (some versions of tree-sitter bindings miss it or behave inconsistently)
if (!SyntaxNode.prototype.hasOwnProperty('text')) {
    Object.defineProperty(SyntaxNode.prototype, 'text', {
        get() {
            if (!this.tree || !this.tree.sourceText) return "";
            return this.tree.sourceText.slice(this.startIndex, this.endIndex);
        }
    });
}
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { reportError } from './errors.js';
import { UppHelpersC } from './upp_helpers_c.js';
import { DiagnosticCodes, DiagnosticsManager } from './diagnostics.js';

export const RECURSION_LIMITER_ENABLED = false;

/**
 * Main registry class for managing macros, parsing, and transformations.
 * @class
 */
class Registry {
    /**
     * @param {Object} [config={}] - Configuration object.
     * @param {Registry|null} [parentRegistry=null] - The parent registry that spawned this instance.
     */
    constructor(config = {}, parentRegistry = null) {
        /** @type {Object} */
        this.config = config;
        /** @type {Registry|null} */
        this.parentRegistry = parentRegistry;
        /** @type {Map<string, Object>} */
        this.macros = new Map();

        // Built-in Internal Macros
        this.macros.set('__deferred_task', {
            language: 'js',
            params: ['id'],
            body: '/* handled internally */',
            isInternal: true
        });

        this.macros.set('include', {
            language: 'js',
            params: ['file'],
            body: 'upp.loadDependency(file); return "";',
            isInternal: true
        });

        /** @type {Array<Object>} */
        this.invocations = [];
        /** @type {string} */
        this.sourceCode = '';
        /** @type {string} */
        this.filePath = '';
        /** @type {import('./dependency_cache.js').DependencyCache|null} */
        this.cache = config.cache || null;
        /** @type {DiagnosticsManager} */
        this.diagnostics = config.diagnostics || new DiagnosticsManager(config);
        this.statsEnabled = !!config.stats;
        /** @type {Array<function>} */
        this.transforms = [];
        /** @type {Map<string, import('tree-sitter').Query>} */
        this.queryCache = new Map();
        /** @type {Object} */
        this.language = C;

        // Handle ESM/CJS interop for language modules
        if (this.language && this.language.default) {
            this.language = this.language.default;
        }
        this.parser = new Parser();
        this.parser.setLanguage(this.language);

        /** @type {UppHelpersC} */
        this.helpers = new UppHelpersC(this);
        /** @type {Array<import('tree-sitter').Tree>} */
        this.allTrees = [];
        /** @type {number} */
        this.idCounter = 0;
        /** @type {Set<string>} */
        this.loadedDependencies = new Set();
        /** @type {Map<any, Set<number>>} */
        this.visitedNodes = new Map();

        // Statistics
        this.uid = Math.random().toString(36).slice(2, 6);
        this.stats = { visitsAvoided: 0, visitsAllowed: 0 };

        /** @type {Map<number, function>} */
        this.deferredTasks = new Map();
        /** @type {number} */
        this.deferredTaskIdCounter = 0;
        /** @type {string|null} */
        this.activeMacro = null;
        this.activeMacroInvocation = null;
        this.transformDepth = 0;
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.activeTransformNode = null;
        /** @type {Map<string, string>} */
        this.markerMap = new Map();
        this.markerCounter = 0;
        this.scopeTasks = new Map();
    }

    /**
     * Registers a deferred task and returns its ID.
     * @param {function} callback - The task function.
     * @returns {number} The task ID.
     */
    registerDeferredTask(callback, targetNodeId = null) {
        const id = ++this.deferredTaskIdCounter;

        // If no target ID provided, default to the current tree's root
        const actualTargetId = targetNodeId !== null ? targetNodeId : (this.allTrees.length > 0 ? this.allTrees[this.allTrees.length - 1].rootNode.id : null);

        this.deferredTasks.set(id, { callback, targetNodeId: actualTargetId });
        if (actualTargetId !== null) {
            if (!this.scopeTasks.has(actualTargetId)) {
                this.scopeTasks.set(actualTargetId, []);
            }
            this.scopeTasks.get(actualTargetId).push(id);
        }
        return id;
    }

    /**
     * Retrieves a macro definition, checking parent registries if needed.
     * @param {string} name - The macro name.
     * @returns {Object|undefined} The macro definition.
     */
    getMacro(name) {
        if (this.macros.has(name)) return this.macros.get(name);
        if (this.parentRegistry) return this.parentRegistry.getMacro(name);
        return undefined;
    }

    /**
     * internal helper - parses source code string to tree
     * @private
     * @param {string} source - Source code to parse.
     * @returns {import('tree-sitter').Tree} Tree-sitter tree.
     */
    _parse(source, oldTree) {
        const parser = new Parser();
        parser.setLanguage(this.language);

        let tree;
        if (typeof source !== 'string') {
            tree = parser.parse("");
        } else {
            tree = parser.parse(source);
        }
        if (tree) tree.sourceText = source;
        return tree;
    }

    /**
     * Registers usage source code and finds initial macro definitions.
     * @param {string} sourceCode - The source code.
     * @param {string} filePath - The file path.
     */
    registerSource(sourceCode, filePath) {
        this.filePath = filePath;
        this.sourceCode = sourceCode;
        // Local macros
        const localMacros = this.scanMacros(this.sourceCode, this.filePath);
        for (const [name, macro] of localMacros) {
            this.macros.set(name, macro);
        }
    }

    /**
     * Scans source code for macro definitions and returns them.
     */
    scanMacros(source, originPath = 'unknown') {
        const badSyntaxRegex = /@define(?:@\w+)?\s+(\w+)\s*\{/g;
        let badMatch;
        while ((badMatch = badSyntaxRegex.exec(source)) !== null) {
             const name = badMatch[1];
             const { line, col } = DiagnosticsManager.getLineCol(source, badMatch.index);
             this.diagnostics.reportError(
                 DiagnosticCodes.SYNTAX_ERROR,
                 `Macro definition for '@${name}' is missing parentheses. Use '@define ${name}() { ... }'.`,
                 originPath,
                 line,
                 col,
                 source
             );
        }

        const found = new Map();
        const regex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        let match;
        while ((match = regex.exec(source)) !== null) {
            const [fullMatch, langTag, name, params] = match;
            const bodyStart = match.index + fullMatch.length;
            const body = this.extractBody(source, bodyStart);
            if (body !== null) {
                const { line, col } = DiagnosticsManager.getLineCol(source, match.index);

                if (this.macros.has(name)) {
                     const existing = this.macros.get(name);
                     const existingLoc = existing.origin ? ` (previously known from ${existing.origin})` : '';

                     // Omit warning if:
                     // 1. It's the exact same definition from the same file/offset
                     // 2. The existing macro is internal (allowing "upgrading" via stdlib)
                     if ((existing.origin === originPath && existing.startIndex === match.index) || existing.isInternal) {
                          // Identical definition or upgrading internal macro
                     } else {
                         this.diagnostics.reportWarning(
                             DiagnosticCodes.MACRO_REDEFINITION,
                             `Macro @${name} redefined${existingLoc}`,
                             originPath,
                             line,
                             col,
                             source
                         );
                     }
                }

                found.set(name, {
                    language: langTag || 'js',
                    params: params.split(',').map(s => s.trim()).filter(s => s.length > 0),
                    body: body.trim(),
                    startIndex: match.index,
                    endIndex: bodyStart + body.length + 1,
                    origin: originPath,
                    line,
                    col
                });
            }
        }
        return found;
    }

    setSourceCode(code) {
        this.sourceCode = code;
    }

    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        let inString = null;
        let inComment = false;
        let blockComment = false;

        while (depth > 0 && i < source.length) {
            const char = source[i];
            const nextChar = source[i + 1];

            if (inString) {
                if (char === '\\') i++;
                else if (char === inString) inString = null;
            } else if (blockComment) {
                if (char === '*' && nextChar === '/') { blockComment = false; i++; }
            } else if (inComment) {
                if (char === '\n') inComment = false;
            } else {
                if (char === '/' && nextChar === '/') inComment = true;
                else if (char === '/' && nextChar === '*') { blockComment = true; i++; }
                else if (char === "'" || char === '"' || char === '`') inString = char;
                else if (char === '{') depth++;
                else if (char === '}') depth--;
            }
            i++;
        }
        return depth === 0 ? source.substring(startOffset, i - 1) : null;
    }

    findInvocations(source) {
        const invocations = [];
        let searchIndex = 0;
        const lines = source.split('\n');
        const lineStartIndices = [];
        let currentIdx = 0;
        for (const line of lines) {
            lineStartIndices.push(currentIdx);
            currentIdx += line.length + 1;
        }

        const getPos = (idx) => {
            let line = 0;
            while (line < lineStartIndices.length - 1 && lineStartIndices[line + 1] <= idx) {
                line++;
            }
            return { line: line + 1, col: idx - lineStartIndices[line] + 1 };
        };

        while (searchIndex < source.length) {
            const atIndex = source.indexOf('@', searchIndex);
            if (atIndex === -1) break;

            if (this.isInsideDefinition(atIndex, source)) {
                searchIndex = atIndex + 1;
                continue;
            }

            const inv = this.absorbInvocation(source, atIndex);
            if (inv) {
                const pos = getPos(atIndex);
                inv.line = pos.line;
                inv.col = pos.col;
                invocations.push(inv);
                searchIndex = inv.endIndex;
            } else {
                searchIndex = atIndex + 1;
            }
        }
        return invocations;
    }

    isInsideDefinition(index, source = null) {
        const src = source || this.sourceCode;
        const regex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        let match;
        while ((match = regex.exec(src)) !== null) {
            const body = this.extractBody(src, match.index + match[0].length);
            if (body !== null) {
                const start = match.index;
                const end = match.index + match[0].length + body.length + 1;
                if (index >= start && index < end) return true;
            }
        }
        return false;
    }

    absorbInvocation(source, startIndex) {
        const remainingSource = source.substring(startIndex);
        const match = remainingSource.match(/^@(\w+)\s*(\(([^)]*)\))?/);
        if (match) {
            const fullMatch = match[0];
            const name = match[1];
            const argsString = match[3];
            let args = [];
            if (argsString) {
                args = argsString.split(',').filter(s => s.trim()).map(s => s.trim());
            }
            return { name, args, startIndex, endIndex: startIndex + fullMatch.length };
        }
        return null;
    }

    process() {
        this.deferredTasks = new Map();
        this.scopeTasks = new Map();
        this.deferredTaskIdCounter = 0;
        this.visitedNodes = new Map();
        this.allTrees = [];
        this.helpers.replacements = [];
        this.helpers.replacementMap = new Map();
        this.mainTree = null;

        if (typeof this.sourceCode !== 'string') this.sourceCode = "";

        let result = this.transform(this.sourceCode, this.filePath);

        const finalTree = this._parse(result);
        const finalHelpers = new UppHelpersC(this);
        finalHelpers.root = finalTree.rootNode;
        this.applyTransforms(finalTree.rootNode, finalHelpers);

        if (finalHelpers.replacements.length > 0) {
            result = this.applyReplacements(result, finalHelpers.replacements);
        }

        return this.finishProcessing(result);
    }

    finishProcessing(code) {
        let output = code;
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        const taskRegex = /@__deferred_task\(\d+\)/g;

        const definitionsToStrip = [];
        let dMatch;
        while ((dMatch = defineRegex.exec(output)) !== null) {
            const body = this.extractBody(output, dMatch.index + dMatch[0].length);
            if (body !== null) {
                definitionsToStrip.push({
                    start: dMatch.index,
                    end: dMatch.index + dMatch[0].length + body.length + 1
                });
            }
        }
        definitionsToStrip.sort((a, b) => b.start - a.start);
        for (const change of definitionsToStrip) {
            output = output.slice(0, change.start) + output.slice(change.end);
        }
        output = output.replace(taskRegex, "");
        return output.trim();
    }

    transform(source, originPath = 'unknown', parentHelpers = null) {
        const { cleanSource, invocations: foundInvs } = this.prepareSource(source);
        const tree = this._parse(cleanSource);
        if (!tree) return source;
        const isMain = !this.mainTree || originPath === this.filePath;
        if (isMain) {
            this.mainTree = tree;
            this.markerMap.clear();
            this.markerCounter = 0;
            this.invocations = this.findInvocations(source);
        }

        const helpers = isMain ? this.helpers : new UppHelpersC(this);
        if (parentHelpers) {
            helpers.topLevelInvocation = parentHelpers.topLevelInvocation || parentHelpers.invocation;
        }
        const invocations = this.findInvocations(source);
        helpers.root = tree.rootNode;
        helpers.currentInvocations = invocations;

        return this.transformNode(tree.rootNode, cleanSource, helpers, originPath);
    }

    transformNode(node, source, helpers, originPath) {
        if (!node) return "";
        if (helpers.isConsumed(node)) return "";

        const oldActive = this.activeTransformNode;
        this.activeTransformNode = node;
        try {
            let repl = helpers.getReplacement(node);
            if (repl) {
                return this.transform(repl.content, `replacement-of-${node.type}`, helpers);
            }

            const parts = [];
            let cursor = node.startIndex;

            if (node.type === 'translation_unit' || !node.parent) {
                cursor = 0;
            }

            const processText = (text, startIdx) => {
                let subCursor = 0;
                const subParts = [];
                const textEnd = startIdx + text.length;
                const localInvs = helpers.currentInvocations.filter(inv =>
                    inv.startIndex >= startIdx && inv.startIndex < textEnd && inv.endIndex <= textEnd
                ).sort((a,b) => a.startIndex - b.startIndex);

                for (const inv of localInvs) {
                    const macro = this.getMacro(inv.name);
                    if (!macro) {
                         continue;
                    }

                    if (inv.startIndex > startIdx + subCursor) {
                        subParts.push(text.slice(subCursor, inv.startIndex - startIdx));
                    }
                    const result = this.evaluateMacro(inv, source, helpers, originPath);
                    subParts.push(this.transform(result, `result-of-@${inv.name}`, {
                        invocation: inv,
                        topLevelInvocation: helpers.topLevelInvocation || helpers.invocation
                    }));
                    subCursor = inv.endIndex - startIdx;
                }

                if (subCursor < text.length) {
                    subParts.push(text.slice(subCursor));
                }
                return subParts.join("");
            };

            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child.startIndex > cursor) {
                    const gapText = source.slice(cursor, child.startIndex);
                    parts.push(processText(gapText, cursor));
                }
                parts.push(this.transformNode(child, source, helpers, originPath));
                cursor = child.endIndex;
            }

            if (node.endIndex > cursor) {
                const gapText = source.slice(cursor, node.endIndex);
                parts.push(processText(gapText, cursor));
            }

            let combined = parts.join('');

            repl = helpers.getReplacement(node);
            if (repl) {
                return this.transform(repl.content, `deferred-replacement-of-${node.type}`, helpers);
            }

            if (this.scopeTasks.has(node.id)) {
                const tasks = this.scopeTasks.get(node.id);
                for (const taskId of tasks) {
                    const taskInfo = this.deferredTasks.get(taskId);
                    if (taskInfo) {
                        combined = this.executeDeferredTask(combined, taskInfo.callback, originPath);
                    }
                }
            }

            if (combined.includes('__UPP_MARKER_')) {
                for (const [marker, content] of this.markerMap.entries()) {
                    if (combined.includes(marker)) {
                        const transformed = this.transform(content, `marker-${marker}`, helpers);
                        combined = combined.split(marker).join(transformed);
                    }
                }
            }
            return combined;
        } finally {
            this.activeTransformNode = oldActive;
        }
    }

    evaluateMacro(invocation, source, helpers, filePath) {
        const macro = this.getMacro(invocation.name);
        if (!macro) return "";

        if (RECURSION_LIMITER_ENABLED && !this.visit(invocation.name, invocation.startIndex)) {
            return "";
        }

        const macroFn = new Function('upp', 'console', ...macro.params, macro.body);

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;

        let invocationNode = null;
        try {
            invocationNode = helpers.root.descendantForIndex(invocation.startIndex, invocation.endIndex);
        } catch (e) {
            console.log(`DEBUG: evaluateMacro failed to get invocationNode for @${invocation.name} at ${invocation.startIndex}`);
        }
        let contextNode = invocationNode;
        if (contextNode && (
            contextNode.type === 'translation_unit' ||
            contextNode.type === 'compound_statement' ||
            contextNode === helpers.root
        )) {
             const nextNode = helpers.findNextNodeAfter(helpers.root, invocation.endIndex);
             if (nextNode && nextNode.type !== 'translation_unit' && nextNode.type !== 'compound_statement' && nextNode.id !== helpers.root.id) {
                 contextNode = nextNode;
             } else {
                 contextNode = (invocationNode && invocationNode.type !== 'translation_unit') ? invocationNode : null;
             }
        }
        helpers.invocation = { ...invocation, invocationNode };
        helpers.contextNode = contextNode;
        helpers.lastConsumedNode = null;

        const oldMacroInv = this.activeMacroInvocation;
        this.activeMacroInvocation = invocation;
        try {
            const args = [...invocation.args];
            let isTransformer = false;
            if (macro.params.length > 0 && macro.params[0] === 'node') {
                args.unshift(contextNode);
                isTransformer = true;
            }

            if (args.length !== macro.params.length) {
                const expectedCount = isTransformer ? macro.params.length - 1 : macro.params.length;
                const foundCount = invocation.args.length;
                const err = new Error(`@${invocation.name} expected ${expectedCount} arguments, but found ${foundCount}`);
                err.isUppError = true;
                throw err;
            }

            this.activeMacro = invocation.name;
            const result = macroFn(helpers, console, ...args);
            this.activeMacro = null;
            let output = result !== undefined ? (typeof result === 'object' ? result.text : String(result)) : "";
            return output;
        } catch (err) {
            if (!err.isUppError) {
                console.error(`Macro @${invocation.name} failed:`, err);
                if (err.stack) console.error(err.stack);
            }
            this.diagnostics.reportError(
                 0,
                 `Macro @${invocation.name} failed: ${err.message}`,
                 this.filePath,
                 invocation.line || 0,
                 invocation.col || 0,
                 this.sourceCode
             );
             return "";
        } finally {
            this.activeMacroInvocation = oldMacroInv;
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
        }
    }

    executeDeferredTask(combinedText, callback, originPath) {
        const isTU = combinedText.includes('main') && (combinedText.includes('int ') || combinedText.includes('void '));
        // We wrap in a function IF it doesn't look like a full TU.
        // Most deferred tasks (like @defer) are in blocks.
        const wrappedSource = isTU ? combinedText : `void __upp_temp_func() {\n${combinedText}\n}`;
        const tempTree = this._parse(wrappedSource);
        const tempHelpers = new UppHelpersC(this);

        let targetNode = tempTree.rootNode;
        if (!isTU) {
            let func = tempTree.rootNode.child(0);
            if (func && func.type === 'function_definition') {
                targetNode = func.childForFieldName('body');
            }
        }

        tempHelpers.root = targetNode;
        tempHelpers.isDeferred = true;

        callback(targetNode, tempHelpers);

        if (tempHelpers.replacements.length > 0) {
            const adjustedReplacements = isTU ? tempHelpers.replacements : tempHelpers.replacements.map(r => ({
                ...r,
                start: r.start - 25, // length of "void __upp_temp_func() {\n"
                end: r.end - 25
            })).filter(r => r.start >= 0);

            return this.applyReplacements(combinedText, adjustedReplacements);
        }
        return combinedText;
    }

    applyReplacements(text, replacements) {
        if (!replacements || replacements.length === 0) return text;

        // 1. Filter out exact duplicates
        const unique = [];
        const seen = new Set();
        for (const r of replacements) {
            const key = `${r.start}:${r.end}:${r.content}`;
            if (!seen.has(key)) {
                unique.push(r);
                seen.add(key);
            }
        }

        // 2. Sort primary order (END descriptor first for stability of insertions)
        const sorted = unique.sort((a, b) => a.start - b.start || a.end - b.end);

        // 3. Remove conflicting overlaps (NOT insertions)
        const filtered = [];
        let lastEnd = -1;
        for (const r of sorted) {
            const isInsertion = (r.start === r.end);
            if (isInsertion || r.start >= lastEnd) {
                filtered.push(r);
                if (r.end > lastEnd) lastEnd = r.end;
            }
        }

        const reversed = filtered.sort((a, b) => b.start - a.start || b.end - a.end);
        let result = text;
        for (const r of reversed) {
            result = result.slice(0, r.start) + r.content + result.slice(r.end);
        }
        return result;
    }

    prepareSource(source) {
        if (source === undefined || source === null) return { cleanSource: "", invocations: [] };
        let cleanSource = String(source);
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        let dMatch;
        const definitionsToStrip = [];

        const getBraceDepth = (text) => {
            let depth = 0;
            let inString = null;
            let inComment = false;
            let blockComment = false;
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                const nextChar = text[i + 1];
                if (inString) {
                    if (char === '\\') i++;
                    else if (char === inString) inString = null;
                } else if (blockComment) {
                    if (char === '*' && nextChar === '/') { blockComment = false; i++; }
                } else if (inComment) {
                    if (char === '\n') inComment = false;
                } else {
                    if (char === '/' && nextChar === '/') inComment = true;
                    else if (char === '/' && nextChar === '*') { blockComment = true; i++; }
                    else if (char === "'" || char === '"' || char === '`') inString = char;
                    else if (char === '{') depth++;
                    else if (char === '}') depth--;
                }
            }
            return depth;
        };

        while ((dMatch = defineRegex.exec(cleanSource)) !== null) {
            const precedingText = cleanSource.slice(0, dMatch.index);
            if (getBraceDepth(precedingText) > 0) {
                const lines = precedingText.split('\n');
                this.diagnostics.reportError(
                    0,
                    `Syntax Error: @define is only allowed at the top-level lexical scope.`,
                    this.filePath,
                    lines.length,
                    lines[lines.length - 1].length,
                    cleanSource
                );
            }

            const body = this.extractBody(cleanSource, dMatch.index + dMatch[0].length);
            if (body !== null) {
                definitionsToStrip.push({
                    start: dMatch.index,
                    end: dMatch.index + dMatch[0].length + body.length + 1
                });
            }
        }

        definitionsToStrip.sort((a, b) => b.start - a.start);
        for (const range of definitionsToStrip) {
            const text = cleanSource.slice(range.start, range.end);
            const replacement = text.replace(/[^\r\n]/g, ' ');
            cleanSource = cleanSource.slice(0, range.start) + replacement + cleanSource.slice(range.end);
        }

        const foundInvs = this.findInvocations(cleanSource);
        const invsToMask = [...foundInvs].sort((a, b) => b.startIndex - a.startIndex);
        for (const inv of invsToMask) {
            const text = cleanSource.slice(inv.startIndex, inv.endIndex);
            const replacement = text.replace(/[^\r\n]/g, ' ');
            cleanSource = cleanSource.slice(0, inv.startIndex) + replacement + cleanSource.slice(inv.endIndex);
        }
        return { cleanSource, invocations: foundInvs };
    }

    visit(name, id) {
        if (!this.visitedNodes.has(name)) this.visitedNodes.set(name, new Set());
        let nodeId = id;
        if (typeof id === 'object' && id !== null && id.id !== undefined) nodeId = id.id;
        if (this.visitedNodes.get(name).has(nodeId)) {
            this.stats.visitsAvoided++;
            return false;
        }
        this.visitedNodes.get(name).add(nodeId);
        this.stats.visitsAllowed++;
        return true;
    }

    applyTransforms(rootNode, helpers) {
        for (const transform of this.transforms) {
            try {
                transform(rootNode, helpers);
            } catch (e) {
                console.error(`Transform failed: ${e.message}`);
            }
        }
    }

    registerTransform(fn) {
        this.transforms.push(fn);
    }

    resolveInclude(filePath) {
        if (path.isAbsolute(filePath)) return fs.existsSync(filePath) ? filePath : null;
        const includePaths = this.config.includePaths || [];
        for (const p of includePaths) {
            const fullPath = path.resolve(p, filePath);
            if (fs.existsSync(fullPath)) return fullPath;
        }
        return null;
    }

    loadDependency(filePath) {
        const resolved = this.resolveInclude(filePath);
        if (!resolved || this.loadedDependencies.has(resolved)) return;
        this.loadedDependencies.add(resolved);
        try {
            const source = fs.readFileSync(resolved, 'utf8');
            const macros = this.scanMacros(source, resolved);
            for (const [name, macro] of macros) {
                this.macros.set(name, macro);
            }
            const invocations = this.findInvocations(source);
            for (const inv of invocations) {
                if (inv.name === 'include' && inv.args.length > 0) {
                    this.loadDependency(inv.args[0]);
                }
            }
        } catch (e) {
            console.error(`Failed to load dependency ${filePath}: ${e.message}`);
        }
    }

    isInsideInvocation(start, end) {
        if (!this.invocations) return false;
        return this.invocations.some(inv => {
             if (this.activeMacroInvocation &&
                 inv.startIndex === this.activeMacroInvocation.startIndex &&
                 inv.endIndex === this.activeMacroInvocation.endIndex) {
                 return false;
             }
             return (start >= inv.startIndex && start < inv.endIndex) ||
                    (end > inv.startIndex && end <= inv.endIndex) ||
                    (start < inv.startIndex && end > inv.endIndex);
        });
    }

    getDefinition(node) {
        if (!node) return null;
        return this.resolveSymbol(node.text, node);
    }

    resolveSymbol(name, context, options = {}) {
        let current = context;
        while (current) {
            if (current.type === 'compound_statement' || current.type === 'translation_unit' || current.type === 'function_definition' || current.type === 'parameter_list') {
                const def = this.findDefinitionInScope(name, current);
                if (def) return def;
            }
            current = current.parent;
        }
        return null;
    }

    findDefinitionInScope(name, scope) {
         const queryStr = `
            [
              (declaration
                declarator: [
                  (identifier) @id
                  (init_declarator declarator: (identifier) @id)
                  (pointer_declarator declarator: (identifier) @id)
                  (array_declarator declarator: (identifier) @id)
                ])
              (parameter_declaration
                declarator: [
                  (identifier) @id
                  (pointer_declarator declarator: (identifier) @id)
                  (array_declarator declarator: (identifier) @id)
                ])
              (function_definition
                declarator: (function_declarator
                  declarator: [
                    (identifier) @id
                    (pointer_declarator declarator: (identifier) @id)
                    (parenthesized_declarator (identifier) @id)
                  ]))
              (type_definition
                declarator: (type_identifier) @id)
            ]
         `;
         try {
             const query = new Query(this.language, queryStr);
             const matches = query.matches(scope);
             for (const m of matches) {
                 for (const c of m.captures) {
                     if (c.node.text === name) {
                         return c.node;
                     }
                 }
             }
         } catch (e) {
             console.error(`findDefinitionInScope query failed: ${e.message}`);
         }
         return null;
    }

    findReferences(node) {
        if (!node || !this.mainTree) return [];
        let name = typeof node === 'string' ? node : node.text;

        // If it's a declaration-like node, try to find the actual identifier
        if (typeof node !== 'string' && (node.type === 'declaration' || node.type === 'parameter_declaration')) {
             try {
                // Use a query to find the primary identifier in this declaration
                const q = new Query(this.language, '(declaration declarator: [(identifier) @id (init_declarator declarator: (identifier) @id) (pointer_declarator declarator: (identifier) @id)])');
                const m = q.matches(node);
                if (m.length > 0 && m[0].captures.length > 0) {
                    name = m[0].captures[0].node.text;
                }
             } catch(e) {}
        }

        const root = this.mainTree.rootNode;
        const results = [];
        try {
            const query = new Query(this.language, `[(identifier) @id (type_identifier) @id]`);
            const matches = query.matches(root);
            for (const m of matches) {
                for (const c of m.captures) {
                    if (c.node.text === name) {
                        results.push(c.node);
                    }
                }
            }
        } catch (e) {
            console.error(`findReferences query failed: ${e.message}`);
        }
        return results;
    }
}

export { Registry };
