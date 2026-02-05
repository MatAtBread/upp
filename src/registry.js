import Parser from 'tree-sitter';
const { Query } = Parser;
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
        this.macros.set('__deferred_task', {
            language: 'js',
            params: ['id'],
            body: '/* handled internally */',
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
        // ALWAYS create a fresh parser instance to avoid "NodeClass is not a constructor"
        // errors which occur when a shared parser is reused (e.g. in recursive macro loading).
        // This ensures strict isolation of Tree objects.
        const parser = new Parser();
        parser.setLanguage(this.language);

        if (typeof source !== 'string') {
            return parser.parse("");
        }
        return parser.parse(source); // Force full parse, ignore oldTree
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
     * @param {string} source - The source code.
     * @param {string} [originPath='unknown'] - Origin file path for debugging.
     * @returns {Map<string, Object>} Found macros.
     */

    scanMacros(source, originPath = 'unknown') {
        // Validation: Check for definitions missing parentheses
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

                // Check if macro is already defined (globally or locally in this scan)
                // Note: scanMacros returns a Map of *newly* found macros.
                // Redefinition checks should happen when we merge them into the main registry OR here if we have access.
                // We have access to this.macros.
                if (this.macros.has(name)) {
                     const existing = this.macros.get(name);

                     // Helper message
                     const existingLoc = existing.origin ? ` (previously known from ${existing.origin})` : '';

                     // User Option 3: "macro re-definitions from the same position in the same file should not be considered UPP001 errors"
                     // This happens when the same header is included multiple times via different paths or contexts.
                     if (existing.origin === originPath && existing.startIndex === match.index) {
                         // Identical definition (same file, same position). Silent ignore.
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
                    startIndex: match.index, // Note: indices are relative to the file content passed
                    endIndex: bodyStart + body.length + 1,
                    origin: originPath,
                    line,
                    col
                });
            }
        }
        return found;
    }

    /**
     * Updates the source code.
     * @param {string} code - New source code.
     */
    setSourceCode(code) {
        this.sourceCode = code;
        // The main tree will be parsed at the start of process()
    }

    /**
     * Extracts a balanced code block body.
     * @private
     * @param {string} source - The source code.
     * @param {number} startOffset - Offset where the body starts.
     * @returns {string|null} The extracted body text or null.
     */
    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        let inString = null; // ' or " or `
        let inComment = false; // // or /*
        let blockComment = false;

        while (depth > 0 && i < source.length) {
            const char = source[i];
            const nextChar = source[i + 1];

            if (inString) {
                if (char === '\\') i++; // skip escaped
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

    /**
     * Finds all macro invocations in the source.
     * @param {string} source - The source code.
     * @returns {Array<Object>} List of invocation objects.
     */
    /**
     * Finds all macro candidates in the source.
     * @param {string} source - The source code.
     * @returns {Array<Object>} List of invocation objects.
     */
    findInvocations(source) {
        const invocations = [];
        let searchIndex = 0;

        // Pre-calculate line pointers for fast line/col lookup
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

    /**
     * Checks if an index is inside a macro definition.
     * @param {number} index - The index to check.
     * @param {string} [source] - The source code to check against.
     * @returns {boolean} True if inside a definition.
     */
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

    /**
     * Parses a macro invocation string from source.
     * @param {string} source - The source code.
     * @param {number} startIndex - The start index of the possible invocation.
     * @returns {Object|null} Invocation details or null.
     */
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

    /**
     * Main processing entry point.
     * @returns {string} The transformed source code.
     */
    process() {
        this.deferredTasks = new Map();
        this.scopeTasks = new Map();
        this.deferredTaskIdCounter = 0;
        this.visitedNodes = new Map();
        this.allTrees = [];

        if (typeof this.sourceCode !== 'string') {
             this.sourceCode = "";
        }

        // Global transformation
        let result = this.transform(this.sourceCode, this.filePath);

        // Apply any global transforms if registered
        const finalTree = this._parse(result);
        const finalHelpers = new UppHelpersC(this);
        finalHelpers.root = finalTree.rootNode;
        this.applyTransforms(finalTree, finalHelpers);

        if (finalHelpers.replacements.length > 0) {
            result = this.applyReplacements(result, finalHelpers.replacements);
        }

        return this.finishProcessing(result);
    }
    finishProcessing(code) {
        let output = code;
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        const taskRegex = /@__deferred_task\(\d+\)/g;

        // Remove macro definitions
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

        // Remove markers
        output = output.replace(taskRegex, "");

        return output.trim();
    }

    transform(source, originPath = 'unknown') {
        const { cleanSource, invocations: foundInvs } = this.prepareSource(source);
        const tree = this._parse(cleanSource);
        if (!tree) return source;

        const helpers = new UppHelpersC(this);
        const invocations = this.findInvocations(source);
        helpers.root = tree.rootNode;
        helpers.currentInvocations = invocations;

        return this.transformNode(tree.rootNode, cleanSource, helpers, originPath);
    }

    /**
     * Recursive node walker for transformation.
     */
    transformNode(node, source, helpers, originPath) {
        if (!node) return "";
        if (helpers.isConsumed(node)) return "";

        const repl = helpers.getReplacement(node);
        if (repl) {
            // Apply replacement and recursively transform its content
            return this.transform(repl.content, `replacement-of-${node.type}`);
        }

        const parts = [];
        let cursor = node.startIndex;

        // Root nodes must start at 0 to capture leading gaps/macros
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
                // Late-binding check: only evaluate if it's actually registered now
                // (e.g. might have been registered by a preceding @include)
                if (!this.getMacro(inv.name)) {
                    continue;
                }

                // Text before macro
                if (inv.startIndex > startIdx + subCursor) {
                    subParts.push(text.slice(subCursor, inv.startIndex - startIdx));
                }
                // Evaluate macro
                const result = this.evaluateMacro(inv, source, helpers, originPath);
                subParts.push(this.transform(result, `result-of-@${inv.name}`));

                subCursor = inv.endIndex - startIdx;
            }

            if (subCursor < text.length) {
                subParts.push(text.slice(subCursor));
            }
            return subParts.join("");
        };

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);

            // Gap handling (macros often live here)
            if (child.startIndex > cursor) {
                const gapText = source.slice(cursor, child.startIndex);
                parts.push(processText(gapText, cursor));
            }

            // Recurse into child
            parts.push(this.transformNode(child, source, helpers, originPath));
            cursor = child.endIndex;
        }

        // Final gap
        if (node.endIndex > cursor) {
            const gapText = source.slice(cursor, node.endIndex);
            parts.push(processText(gapText, cursor));
        }

        let combined = parts.join('');

        // If this is a scope with deferred tasks, execute them
        if (this.scopeTasks.has(node.id)) {
            const tasks = this.scopeTasks.get(node.id);
            for (const taskId of tasks) {
                const taskInfo = this.deferredTasks.get(taskId);
                if (taskInfo) {
                    combined = this.executeDeferredTask(combined, taskInfo.callback, originPath);
                }
            }
        }

        return combined;
    }

    /**
     * Evaluates a single macro.
     */
    evaluateMacro(invocation, source, helpers, filePath) {
        const macro = this.getMacro(invocation.name);
        if (!macro) return "";

        // Use startIndex as unique identifier for gap-macros to avoid recursion-safety collisions
        if (RECURSION_LIMITER_ENABLED && !this.visit(invocation.name, invocation.startIndex)) {
            return ""; // Recursion safety
        }

        const macroFn = new Function('upp', 'console', ...macro.params, macro.body);

        // Setup context for evaluation
        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;

        const invocationNode = helpers.root.descendantForIndex(invocation.startIndex, invocation.endIndex);
        let contextNode = invocationNode;
        if (contextNode && (
            contextNode.type === 'translation_unit' ||
            contextNode.type === 'compound_statement' ||
            contextNode === helpers.root
        )) {
             const nextNode = helpers.findNextNodeAfter(helpers.root, invocation.endIndex);
             if (nextNode && nextNode.type !== 'translation_unit' && nextNode.type !== 'compound_statement' && nextNode.id !== helpers.root.id) {
                 contextNode = nextNode;
             }
        }
        helpers.invocation = { ...invocation, invocationNode };
        helpers.contextNode = contextNode;
        helpers.lastConsumedNode = null;

        try {
            const args = [...invocation.args];
            let isTransformer = false;
            if (macro.params.length > 0 && macro.params[0] === 'node') {
                args.unshift(contextNode);
                isTransformer = true;
            }

            // Validate arity
            if (args.length !== macro.params.length) {
                const expectedCount = isTransformer ? macro.params.length - 1 : macro.params.length;
                const foundCount = invocation.args.length;
                const err = new Error(`@${invocation.name} expected ${expectedCount} arguments, but found ${foundCount}`);
                err.isUppError = true;
                throw err;
            }

            const result = macroFn(helpers, console, ...args);
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
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
        }
    }

    /**
     * Executes a deferred task on transformed text.
     */
    executeDeferredTask(combinedText, callback, originPath) {
        const tempTree = this._parse(combinedText);
        const tempHelpers = new UppHelpersC(this);
        tempHelpers.root = tempTree.rootNode;
        tempHelpers.isDeferred = true;

        callback(tempTree.rootNode, tempHelpers);

        if (tempHelpers.replacements.length > 0) {
            return this.applyReplacements(combinedText, tempHelpers.replacements);
        }
        return combinedText;
    }

    /**
     * Helper to apply replacements to a string.
     */
    applyReplacements(text, replacements) {
        const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end);
        let result = text;
        for (const r of sorted) {
            result = result.slice(0, r.start) + r.content + result.slice(r.end);
        }
        return result;
    }

    /**
     * Prepares source by masking definitions and marking invocations.
     * @param {string} source - Original source.
     * @returns {{cleanSource: string, invocations: Array<Object>}} Prepared source and found invocations.
     */
    prepareSource(source) {
        let cleanSource = source;
        const invocations = [];

        // 1. Mask definitions
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        let dMatch;
        const definitionsToStrip = [];
        while ((dMatch = defineRegex.exec(source)) !== null) {
            const body = this.extractBody(source, dMatch.index + dMatch[0].length);
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

        // 2. Find and mask invocations with spaces to maintain indices
        const foundInvs = this.findInvocations(cleanSource);
        const invsToMask = [...foundInvs].sort((a, b) => b.startIndex - a.startIndex);

        for (const inv of invsToMask) {
            const text = cleanSource.slice(inv.startIndex, inv.endIndex);
            const replacement = text.replace(/[^\r\n]/g, ' ');
            cleanSource = cleanSource.slice(0, inv.startIndex) + replacement + cleanSource.slice(inv.endIndex);
        }

        return { cleanSource, invocations: foundInvs };
    }

    /**
     * Reports an error to the specific file context.
     * @param {import('tree-sitter').SyntaxNode} node - Node causing the error.
     * @param {string} message - Error message.
     * @param {string} [source] - Source code override.
     * @param {string} [filePath] - File path override.
     */
    reportError(node, message, source = null, filePath = null) {
        reportError(node, source || this.sourceCode, message, filePath || this.filePath);
    }

    /**
     * Checks if a range overlaps with any invocation.
     * @param {number} start - Start index.
     * @param {number} end - End index.
     * @returns {boolean} True if overlapping.
     */
    isInsideInvocation(start, end) {
        return (this.invocations || []).some(inv => (start < inv.endIndex && end > inv.startIndex));
    }

    /**
     * Registers a global transformation.
     * @param {function} transformFn - The transform function.
     */
    registerTransform(transformFn) {
        this.transforms.push(transformFn);
    }

    /**
     * Helper to create a Query object.
     * @param {string} pattern - Query pattern.
     * @returns {import('tree-sitter').Query} Query object.
     */
    createQuery(pattern) {
        if (!this.queryCache) this.queryCache = new Map();
        if (this.queryCache.has(pattern)) return this.queryCache.get(pattern);
        const q = new Query(this.language, pattern);
        this.queryCache.set(pattern, q);
        return q;
    }

    /**
     * run registered transforms on the tree
     * @param {import('tree-sitter').Tree} tree - The AST.
     * @param {Object} helpers - The helpers instance.
     */
    applyTransforms(tree, helpers) {
        helpers.root = tree.rootNode || tree;
        const rootNode = tree.rootNode || tree;
        for (const transform of this.transforms) {
            // Set current transform key for recursion avoidance
            helpers.transformKey = transform;
            transform(rootNode, helpers);
        }
    }

    /**
     * Resolves a symbol (variable, type, or tag) in a scope-aware manner.
     * @param {string} name - The symbol name.
     * @param {import('tree-sitter').SyntaxNode} contextNode - The point of reference.
     * @param {Object} [options] - Resolution options.
     * @param {boolean} [options.variable=true] - Search in variable/typedef namespace.
     * @param {boolean} [options.tag=true] - Search in struct/union/enum tag namespace.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition node.
     */
    resolveSymbol(name, contextNode, options = { variable: true, tag: true }) {
        if (!name || !contextNode) return null;

        const queries = [];
        if (options.variable) {
            queries.push(`
                (declaration (identifier) @id)
                (declaration (init_declarator (identifier) @id))
                (declaration (init_declarator (pointer_declarator (identifier) @id)))
                (declaration (pointer_declarator (identifier) @id))
                (type_definition (type_identifier) @id)
                (parameter_declaration (identifier) @id)
                (parameter_declaration (pointer_declarator (identifier) @id))
                (function_definition (function_declarator (identifier) @id))
                (function_definition (pointer_declarator (function_declarator (identifier) @id)))
            `);
        }
        if (options.tag) {
            queries.push(`
                (struct_specifier name: (type_identifier) @id)
                (union_specifier name: (type_identifier) @id)
                (enum_specifier name: (type_identifier) @id)
            `);
        }

        const queryStr = queries.join('\n');

        let scope = contextNode.parent;
        while (scope) {
            if (scope.type === 'compound_statement' || scope.type === 'function_definition' || scope.type === 'translation_unit' || scope.type === 'parameter_list') {
                const matches = this.createQuery(queryStr).matches(scope);

                let bestDef = null;
                for (const m of matches) {
                    const idNode = m.captures[0].node;
                    if (idNode.text === name) {
                        // Resolve to owning definition node for ownership check
                        let p = idNode.parent;
                        while (p && !['declaration', 'parameter_declaration', 'function_definition', 'type_definition', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(p.type)) {
                            p = p.parent;
                        }
                        const defNode = p || idNode;

                        // Ensure this definition is owned DIRECTLY by our current scope
                        let checkP = defNode.parent;
                        while (checkP && !['compound_statement', 'function_definition', 'translation_unit', 'parameter_list'].includes(checkP.type)) {
                            checkP = checkP.parent;
                        }

                        const isOwned = (checkP && checkP.id === scope.id) ||
                                        (scope.type === 'function_definition' && checkP && checkP.type === 'parameter_list');

                        if (isOwned) {
                            // Defined before or at use (for local variables)
                            if (scope.type === 'compound_statement' || scope.type === 'parameter_list') {
                                if (idNode.startIndex <= contextNode.startIndex) {
                                    if (!bestDef || idNode.startIndex > bestDef.startIndex) {
                                        bestDef = defNode;
                                    }
                                }
                            } else {
                                // Globals/parameters are valid anywhere in scope
                                bestDef = defNode;
                            }
                        }
                    }
                }

                if (bestDef) return bestDef;
            }
            scope = scope.parent;
        }
        return null;
    }

    /**
     * Finds the definition node for an identifier.
     * @param {import('tree-sitter').SyntaxNode} node - The identifier node.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition node.
     */
    getDefinition(node) {
        if (!node) return null;
        if (node.type === 'identifier' || node.type === 'type_identifier') {
            return this.resolveSymbol(node.text, node);
        }
        return null;
    }

    /**
     * Finds all references to a definition.
     * @param {import('tree-sitter').SyntaxNode} defNode - The definition node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} List of identifier nodes.
     */
    findReferences(node) {
        if (!node) return [];

        let defNode = node;
        // If passed an identifier, resolve its definition first
        if (node.type === 'identifier') {
            defNode = this.getDefinition(node);
        }

        if (!defNode) return [];

        let name = "";
        try {
            if (defNode.type === 'identifier') {
                name = defNode.text;
            } else {
                const q = this.createQuery('(identifier) @id');
                const matches = q.matches(defNode);
                // The first identifier in a declaration is the name
                if (matches.length > 0) name = matches[0].captures[0].node.text;
            }
        } catch (e) { return []; }

        if (!name) return [];

        // Identify search scope: the enclosing scope of the definition
        let scopeNode = defNode.tree.rootNode;
        let p = defNode.parent;
        while (p) {
            if (p.type === 'compound_statement' || p.type === 'function_definition' || p.type === 'translation_unit' || p.type === 'parameter_list') {
                scopeNode = p;
                break;
            }
            p = p.parent;
        }

        const refs = [];
        try {
            const q = this.createQuery('[(identifier) (field_identifier)] @id');
            const matches = q.matches(scopeNode);
            for (const m of matches) {
                const idNode = m.captures[0].node;
                if (idNode.text === name) {
                    const resolvedDef = this.getDefinition(idNode);
                    if (resolvedDef && defNode && resolvedDef.id === defNode.id) {
                        refs.push(idNode);
                    }
                }
            }
        } catch (e) { }
        return refs;
    }


    /**
     * Mark a node or ID as visited to avoid infinite recursion.
     * @param {any} key - The namespace key (transform function or macro name).
     * @param {any} target - The node or unique ID (like startIndex) to visit.
     * @returns {boolean} True if new visit, False if already visited.
     */
    visit(key, target) {
        if (!RECURSION_LIMITER_ENABLED) return true;
        if (!target && target !== 0) return false;
        if (!this.visitedNodes.has(key)) {
            this.visitedNodes.set(key, new Set());
        }
        const set = this.visitedNodes.get(key);
        const id = (typeof target === 'object' && target.id !== undefined) ? target.id : target;

        if (set.has(id)) {
            this.stats.visitsAvoided++;
            return false;
        }
        this.stats.visitsAllowed++;
        set.add(id);
        return true;
    }

    /**
     * Check if visited.
     * @param {any} key - The namespace key.
     * @param {any} target - The node or ID.
     * @returns {boolean} True if visited.
     */
    isVisited(key, target) {
        if (!target && target !== 0) return false;
        if (!this.visitedNodes.has(key)) return false;
        const set = this.visitedNodes.get(key);
        const id = (typeof target === 'object' && target.id !== undefined) ? target.id : target;
        return set.has(id);
    }


    /**
     * Resolves an include path.
     */
    resolveInclude(importPath) {
        if (path.isAbsolute(importPath)) {
             return fs.existsSync(importPath) ? importPath : null;
        }
        const includePaths = this.config.includePaths || [process.cwd()];
        for (const searchPath of includePaths) {
            const candidate = path.resolve(searchPath, importPath);
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    }

    /**
     * Loads a dependency file.
     */
    loadDependency(filePath) {
        if (this.loadedDependencies.has(filePath)) return;
        this.loadedDependencies.add(filePath);

        try {
            let source;
            if (this.config.preprocess) {
                source = this.config.preprocess(filePath);
            } else {
                source = fs.readFileSync(filePath, 'utf8');
            }

            const fileMacros = this.scanMacros(source, filePath);
            for (const [name, macro] of fileMacros) {
                 if (!this.macros.has(name)) this.macros.set(name, macro);
            }

            if (filePath.endsWith('.hup')) {
                const outputPath = filePath.slice(0, -4) + '.h';
                const tempRegistry = new Registry(this.config, this);
                tempRegistry.registerSource(source, filePath);
                const output = tempRegistry.process();
                fs.writeFileSync(outputPath, output);

                for (const [name, macro] of tempRegistry.macros) {
                    if (!this.macros.has(name)) this.macros.set(name, macro);
                }
                for (const transform of tempRegistry.transforms) {
                    if (!this.transforms.includes(transform)) this.transforms.push(transform);
                }
            } else {
                 // Side effects from top-level macros in headers
                 this.transform(source, filePath);
            }
        } catch (err) {
            console.error(`Failed to load dependency ${filePath}: ${err.message}`);
        }
    }
}

export { Registry };
