import Parser from 'tree-sitter';
const { Query } = Parser;
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { reportError } from './errors.js';
import { UppHelpersC } from './upp_helpers_c.js';
import { DiagnosticCodes, DiagnosticsManager } from './diagnostics.js';

/**
 * Main registry class for managing macros, parsing, and transformations.
 * @class
 */
class Registry {
    /**
     * @param {Object} [config={}] - Configuration object.
     */
    /**
     * @param {Object} [config={}] - Configuration object.
     * @param {import('./dependency_cache.js').DependencyCache} [config.cache] - Shared dependency cache.
     * @param {string[]} [config.includePaths] - List of include paths.
     * @param {function(string): string} [config.preprocess] - Callback to preprocess a file (e.g. run cpp).
     * @param {Registry|null} [parentRegistry=null] - The parent registry that spawned this instance.
     */
    constructor(config = {}, parentRegistry = null) {
        /** @type {Object} */
        this.config = config;
        /** @type {Registry|null} */
        this.parentRegistry = parentRegistry;
        /** @type {Map<string, Object>} */
        this.macros = new Map();
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

        // on-screen usage
        // Statistics
        this.uid = Math.random().toString(36).slice(2, 6);
        this.stats = { visitsAvoided: 0, visitsAllowed: 0 };
        // if (parentRegistry) console.log(`Registry ${this.uid} initialized with parentRegistry ${parentRegistry.uid}`);
        // else console.log(`Registry ${this.uid} initialized WITHOUT parentRegistry`);
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
                     // Allow redefinition if content is identical? OR always warn?
                     // User said: "@xxx" from foo.h and "@xxx" from bar.h are distinct.
                     // But if they share the name, the last one wins in the registry.
                     // Warn about collision.
                     // Distinct files defining same macro -> Collision.
                     // Same file defining same macro twice -> Collision.
                     // If existing.origin !== originPath, it's definitely a cross-file redefinition.

                     // Helper message
                     const existingLoc = existing.origin ? ` (previously known from ${existing.origin})` : '';
                     this.diagnostics.reportWarning(
                         DiagnosticCodes.MACRO_REDEFINITION,
                         `Macro @${name} redefined${existingLoc}`,
                         originPath,
                         line,
                         col,
                         source
                     );
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
     * Finds all macro invocations in the AST.
     * @param {import('tree-sitter').Tree} tree - The AST to search.
     * @param {string} source - The corresponding source code.
     * @returns {Array<Object>} List of invocation objects.
     */
    findInvocations(tree, source) {
        tree = tree || this.mainTree || this._parse(source || this.sourceCode);
        source = source || this.sourceCode;

        const invocations = [];
        const seenIndices = new Set();

        const walk = (node) => {
            if (node.type.includes('comment')) return;
            if (node.type === 'ERROR') {
                const nodeText = node.text.trim();
                if (nodeText === '@' || nodeText.startsWith('@')) {
                    if (!seenIndices.has(node.startIndex) && !this.isInsideDefinition(node.startIndex, source)) {
                        const invocation = this.absorbInvocation(source, node.startIndex);
                        if (invocation && this.getMacro(invocation.name)) {
                            invocations.push({
                                ...invocation,
                                invocationNode: node
                            });
                            seenIndices.add(node.startIndex);
                        }
                    }
                }
            }
            for (let i = 0; i < node.childCount; i++) walk(node.child(i));
        };
        walk(tree.rootNode);
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
     * Main processing loop.
     * @returns {string} The transformed source code.
     */
    process() {
        // console.log(`Process started for registry ${this.uid}`);
        this.allTrees = [];
        let iterations = 0;
        const maxIterations = 100;

        if (typeof this.sourceCode !== 'string') {
             console.error("CRITICAL: process() called without valid sourceCode. Type:", typeof this.sourceCode);
             this.sourceCode = "";
        }

        // Pre-processing handled externally
        // this.processIncludes();

        while (iterations < maxIterations) {
            this.visitedNodes = new Map(); // Reset visited for new pass
            const cleanSource = this.maskDefinitions(this.sourceCode);
            if (typeof cleanSource !== 'string') {
                 console.error("CRITICAL: maskDefinitions returned non-string. Type:", typeof cleanSource);
                 break;
            }
            this.mainTree = this._parse(cleanSource, this.mainTree);
            this.invocations = this.findInvocations(this.mainTree, this.sourceCode);

            if (this.invocations.length === 0) {
                this.helpers.replacements = [];

                // Ensure mainTree is valid and fresh
                if (!this.mainTree) {
                    const cleanSource = this.maskDefinitions(this.sourceCode);
                    this.mainTree = this._parse(cleanSource);
                }

                // console.error("DEBUG SOURCE PASS 2:\n" + this.sourceCode);

                this.applyTransforms(this.mainTree, this.helpers);
                if (this.helpers.replacements.length > 0) {
                    this.applyChanges([]);
                    iterations++;
                    continue;
                }
                break;
            }

            this.helpers.replacements = [];
            // console.log(`Calling evaluateMacros on ${this.uid}`);
            this.evaluateMacros(this.invocations, this.sourceCode, this.helpers, true, this.filePath);
            // console.log(`Returned from evaluateMacros on ${this.uid}`);

            // At this point, this.mainTree has been set to this.cleanTree by evaluateMacros

            // At this point, this.mainTree has been set to this.cleanTree by evaluateMacros
            // this.mainTree is the clean tree (stripped macros).

            this.applyTransforms(this.cleanTree, this.helpers);

            this.applyChanges(this.invocations);
            this.cleanTree = null;
            iterations++;
        }

        if (this.statsEnabled && (this.stats.visitsAvoided > 0 || this.stats.visitsAllowed > 0)) {
            console.error(`[Stats] Recursion Avoidance: Allowed=${this.stats.visitsAllowed}, Avoided=${this.stats.visitsAvoided}`);
        }

        return this.finishProcessing();
    }

    /**
     * Masks macro definitions with spaces to allow valid C parsing.
     * @param {string} source - The source code.
     * @returns {string} Source code with macros replaced by spaces.
     */
    maskDefinitions(source) {
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        const definitionsToStrip = [];
        let dMatch;
        while ((dMatch = defineRegex.exec(source)) !== null) {
            const body = this.extractBody(source, dMatch.index + dMatch[0].length);
            if (body !== null) {
                definitionsToStrip.push({
                    start: dMatch.index,
                    end: dMatch.index + dMatch[0].length + body.length + 1
                });
            }
        }

        let cleanSource = source;
        // Sort reverse to replace safely? Or use slice.
        // definitionsToStrip is in order found.
        // Use loop logic similar to evaluateMacros.
        definitionsToStrip.sort((a, b) => b.start - a.start);

        for (const range of definitionsToStrip) {
            if (range.start >= 0 && range.end <= cleanSource.length) {
                const text = cleanSource.slice(range.start, range.end);
                const replacement = text.replace(/[^\r\n]/g, ' ');
                cleanSource = cleanSource.slice(0, range.start) + replacement + cleanSource.slice(range.end);
            }
        }
        return cleanSource;
    }

    /**
     * Evaluates found macros and schedules replacements.
     * @param {Array<Object>} invocations - Macros to evaluate.
     * @param {string} source - Source code.
     * @param {Object} helpers - Helper instance to use.
     * @param {boolean} [isGlobalPass=false] - Whether this is the main global pass.
     */
    /**
     * Evaluates found macros and schedules replacements.
     * @param {Array<Object>} invocations - Macros to evaluate.
     * @param {string} source - Source code.
     * @param {Object} helpers - Helper instance to use.
     * @param {boolean} [isGlobalPass=false] - Whether this is the main global pass.
     * @param {string} [filePath='unknown'] - File path for error reporting.
     */
    evaluateMacros(invocations, source, helpers, isGlobalPass = false, filePath = 'unknown') {
        // 1. Re-scan for strippable definitions in the CURRENT sourceCode
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
        const definitionsToStrip = [];
        let dMatch;
        while ((dMatch = defineRegex.exec(source)) !== null) {
            const body = this.extractBody(source, dMatch.index + dMatch[0].length);
            if (body !== null) {
                definitionsToStrip.push({
                    start: dMatch.index,
                    end: dMatch.index + dMatch[0].length + body.length + 1
                });
            }
        }

        // 2. Clear source of macros and definitions to find clean target nodes
        let cleanSource = source;
        const allStrippable = [
            ...definitionsToStrip,
            ...invocations.map(i => ({ start: i.startIndex, end: i.endIndex }))
        ];
        allStrippable.sort((a, b) => b.start - a.start);

        for (const range of allStrippable) {
            if (range.start >= 0 && range.end <= cleanSource.length) {
                const text = cleanSource.slice(range.start, range.end);
                const replacement = text.replace(/[^\r\n]/g, ' ');
                cleanSource = cleanSource.slice(0, range.start) + replacement + cleanSource.slice(range.end);
            }
        }

        const cleanTree = this._parse(cleanSource);
        this.allTrees.push(cleanTree);

        if (isGlobalPass) this.mainTree = cleanTree; // Anchor as global for this iteration
        helpers.root = cleanTree.rootNode;
        this.cleanTree = cleanTree; // For contextNode extraction in evaluateMacros
        helpers.currentInvocations = invocations;

        for (const invocation of invocations) {
            // console.log(`Evaluating @${invocation.name} in registry ${this.uid}. Context: ${source.substring(Math.max(0, invocation.startIndex - 20), Math.min(source.length, invocation.endIndex + 20))}`);
            if (invocation.skipped) continue;
            const macro = this.getMacro(invocation.name);
            if (!macro) continue;

            const lastParam = macro.params[macro.params.length - 1];
            const hasRestParam = lastParam && lastParam.startsWith('...');
            const expectedArgs = macro.params.length;

            // Recursion avoidance for macros:
            // Use macro name as key. Check invocationNode.
            if (this.visit(invocation.name, invocation.invocationNode)) {
                 // New visit, proceed
            } else {
                 // Already visited this node for this macro
                 continue;
            }

            const macroFn = new Function('upp', 'console', ...macro.params, macro.body);

            try {
                const actualCount = invocation.args.length;
                if (hasRestParam) {
                    if (actualCount < expectedArgs - 1) {
                        const macroName = `@${invocation.name}`;
                        throw {
                            isUppError: true,
                            node: invocation.invocationNode,
                            message: `${macroName} expected at least ${expectedArgs - 1} arguments, but found ${actualCount}`
                        };
                    }
                } else if (actualCount !== expectedArgs) {
                    const macroName = `@${invocation.name}`;
                    throw {
                        isUppError: true,
                        node: invocation.invocationNode,
                        message: `${macroName} expected ${expectedArgs} arguments, but found ${actualCount}`
                    };
                }
                let searchIndex = invocation.endIndex;
                while (searchIndex < cleanSource.length && /\s/.test(cleanSource[searchIndex])) searchIndex++;
                let targetNode = this.cleanTree.rootNode.namedDescendantForIndex(searchIndex);
                if (targetNode) {
                    while (targetNode.parent &&
                           targetNode.parent.type !== 'translation_unit' &&
                           targetNode.parent.startIndex === targetNode.startIndex) {
                        targetNode = targetNode.parent;
                    }
                    if (targetNode.type === 'translation_unit') targetNode = null;
                }

                helpers.contextNode = targetNode;
                helpers.invocation = invocation;
                helpers.invocation.hasNodeParam = false;
                helpers.lastConsumedNode = null; // Reset for each macro

                const result = macroFn(helpers, console, ...invocation.args);
                helpers.contextNode = null;

                if (result !== undefined) {
                    const content = typeof result === 'object' ? result.text : String(result);
                    // Replaces the invocation itself
                    invocation.replacementContent = content;
                }
            } catch (err) {
                if (err.isUppError) {
                    this.reportError(err.node, err.message, source, filePath);
                } else {
                    console.error(`Evaluation error in @${invocation.name}: ${err.message}`);
                    console.error(err.stack);
                }
                process.exit(1);
            }
        }
    }

    /**
     * Reports an error to the specific file context.
     * @param {import('tree-sitter').SyntaxNode} node - Node causing the error.
     * @param {string} message - Error message.
     */
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
     * Applies queued replacements and macro stripping.
     * @param {Array<Object>} currentInvocations - Invocations processed in this pass.
     */
    applyChanges(currentInvocations) {
        let output = this.sourceCode;
        const macroStripping = currentInvocations.map(i => ({
            start: i.startIndex,
            end: i.endIndex,
            content: i.replacementContent !== undefined ? i.replacementContent : '',
            original: this.sourceCode.substring(i.startIndex, i.endIndex)
        }));

        const allChanges = [...this.helpers.replacements, ...macroStripping]
            .map(c => {
                if (c.original === undefined) {
                    c.original = this.sourceCode.substring(c.start, c.end);
                }
                return c;
            })
            .filter(c => !c.isLocal) // Only main tree replacements
            .sort((a, b) => a.start - b.start || a.end - b.end);

        // Group adjacent changes for cleaner comments
        const mergedChanges = [];
        if (allChanges.length > 0) {
            let current = allChanges[0];
            for (let i = 1; i < allChanges.length; i++) {
                const next = allChanges[i];
                const midText = this.sourceCode.substring(current.end, next.start);
                // Merge if they are adjacent or only separated by whitespace
                if (next.start >= current.end && midText.trim() === '') {
                    current = {
                        start: current.start,
                        end: next.end,
                        content: current.content + midText + next.content,
                        original: current.original + midText + next.original,
                        isLocal: false
                    };
                } else {
                    mergedChanges.push(current);
                    current = next;
                }
            }
            mergedChanges.push(current);
        }

        // Apply changes in reverse order to maintain indices
        mergedChanges.sort((a, b) => b.start - a.start);
        let lastStart = Infinity;
        for (const change of mergedChanges) {
            if (change.end <= lastStart) {
                let finalContent = change.content;
                if (this.config.comments && change.original.trim().length > 0) {
                    const commentText = change.original.replace(/\*\//g, '* /');
                    const comment = `/* ${commentText} */ `;
                    finalContent = comment + finalContent;
                }

                if (this.mainTree) {
                    const startPos = DiagnosticsManager.getLineCol(this.sourceCode, change.start);
                    const oldEndPos = DiagnosticsManager.getLineCol(this.sourceCode, change.end);

                    // 0-indexed conversion
                    startPos.line--; startPos.col--;
                    oldEndPos.line--; oldEndPos.col--;

                    // Calculate new end position
                    // We need to count lines in finalContent to determine row delta
                    // And chars in last line to determine col delta
                    let newLines = 0;
                    let lastLineLen = 0;
                    for (let i = 0; i < finalContent.length; i++) {
                        if (finalContent[i] === '\n') {
                            newLines++;
                            lastLineLen = 0;
                        } else {
                            lastLineLen++;
                        }
                    }

                    const newEndRow = startPos.line + newLines;
                    const newEndCol = newLines === 0 ? startPos.col + lastLineLen : lastLineLen;

                    const edit = {
                        startIndex: change.start,
                        oldEndIndex: change.end,
                        newEndIndex: change.start + finalContent.length,
                        startPosition: { row: startPos.line, column: startPos.col },
                        oldEndPosition: { row: oldEndPos.line, column: oldEndPos.col },
                        newEndPosition: { row: newEndRow, column: newEndCol }
                    };

                    //console.error("Applying edit:", JSON.stringify(edit, null, 2));
                    try {
                        this.mainTree.edit(edit);
                    } catch (e) {
                        // If incremental update fails, discard the old tree to force a clean re-parse
                        // This prevents crashes due to state desync while maintaining robustness
                        this.mainTree = null;
                    }
                }

                output = output.slice(0, change.start) + finalContent + output.slice(change.end);
                lastStart = change.start;
            }
        }
        this.sourceCode = output;
        this.helpers.replacements = [];
    }

    /**
     * Final clean-up pass to remove macro definitions.
     * @returns {string} Final source code.
     */
    finishProcessing() {
        let output = this.sourceCode;
        const defineRegex = /@define(?:@(\w+))?\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
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
        return output;
    }

    /**
     * Expands macros within a code snippet.
     * @param {string} text - The bit of code to expand.
     * @param {import('tree-sitter').SyntaxNode} contextNode - The AST node where this expansion is contextualized.
     * @returns {string} Expanded code.
     */
    expand(text, contextNode) {
        const fragmentHelpers = new UppHelpersC(this); // Assume C for now, or use dynamic helpers
        fragmentHelpers.contextNode = contextNode;
        fragmentHelpers.root = this.helpers.root;

        const snippetParser = new Parser();
        snippetParser.setLanguage(C);
        let tree = snippetParser.parse(text);

        // Nested macro evaluation within the fragment
        let iterations = 0;
        let snippetSource = text;
        while (iterations < 5) { // Depth limit for safety
            const invocations = this.findInvocations(tree, snippetSource);
            if (invocations.length === 0) break;

            const tempHelpers = new UppHelpersC(this);
            tempHelpers.contextNode = contextNode;
            this.evaluateMacros(invocations, snippetSource, tempHelpers, false, 'snippet');

            // Apply changes to the snippet source
            let output = snippetSource;
            const changes = tempHelpers.replacements.sort((a, b) => b.start - a.start);
            for (const c of changes) {
                output = output.slice(0, c.start) + c.content + output.slice(c.end);
            }
            snippetSource = output;
            tree = snippetParser.parse(snippetSource);
            iterations++;
        }

        this.applyTransforms(tree, fragmentHelpers);

        let output = snippetSource;
        const allLocal = fragmentHelpers.replacements.filter(c => c.isLocal).sort((a, b) => b.start - a.start);
        for (const change of allLocal) {
            output = output.slice(0, change.start) + change.content + output.slice(change.end);
        }
        return output;
    }

    /**
     * Checks if a range overlaps with any invocation.
     * @param {number} start - Start index.
     * @param {number} end - End index.
     * @returns {boolean} True if overlapping.
     */
    isInsideInvocation(start, end) {
        return this.invocations.some(inv => (start < inv.endIndex && end > inv.startIndex));
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
        for (const transform of this.transforms) {
            // Set current transform key for recursion avoidance
            helpers.transformKey = transform;
            transform(tree.rootNode || tree, helpers);
        }
    }

    /**
     * Finds the definition node for an identifier.
     * @param {import('tree-sitter').SyntaxNode} node - The identifier node.
     * @returns {import('tree-sitter').SyntaxNode|null} The definition node.
     */
    getDefinition(node) {
        if (!node || node.type !== 'identifier') return null;
        if (!this.mainTree) {
            console.error("DEBUG: getDefinition called but mainTree is null");
            return null;
        }
        const name = node.text;
        let def = null;

        // Search for declarations/parameters with this name
        try {
            const matches = this.createQuery(`
                (declaration (identifier) @id)
                (declaration (init_declarator (identifier) @id))
                (declaration (init_declarator (pointer_declarator (identifier) @id)))
                (declaration (pointer_declarator (identifier) @id))
                (parameter_declaration (identifier) @id)
                (parameter_declaration (pointer_declarator (identifier) @id))
                (function_definition (function_declarator (identifier) @id))
                (function_definition (pointer_declarator (function_declarator (identifier) @id)))
            `).matches(this.mainTree.rootNode);

            for (const m of matches) {
                const idNode = m.captures[0].node;
                if (idNode.text === name && idNode.startIndex <= node.startIndex) {
                    // Return the parent declaration/parameter
                    let p = this.helpers.parent(idNode);
                    while (p && p.type !== 'declaration' && p.type !== 'parameter_declaration' && p.type !== 'function_definition') {
                        p = this.helpers.parent(p);
                    }
                    def = p || idNode;
                }
            }
        } catch (e) {
            console.error(`DEBUG: getDefinition query failed for node ${node.type} (${node.text}): ${e.message}`);
            // throw e; // Suppress crash to allow build to continue
        }
        return def;
    }

    /**
     * Finds all references to a definition.
     * @param {import('tree-sitter').SyntaxNode} defNode - The definition node.
     * @returns {Array<import('tree-sitter').SyntaxNode>} List of identifier nodes.
     */
    findReferences(defNode) {
        if (!defNode) return [];
        if (!this.mainTree) {
            console.error("DEBUG: findReferences called but mainTree is null");
            return [];
        }

        let name = "";
        try {
            if (defNode.type === 'identifier') {
                name = defNode.text;
            } else {
                // Find the identifier inside the declaration
                const q = this.createQuery('(identifier) @id');
                const matches = q.matches(defNode);
                if (matches.length > 0) name = matches[0].captures[0].node.text;
            }
        } catch (e) {
            console.error(`DEBUG: findReferences init query failed on node type ${defNode.type}: ${e.message}`);
            console.error(`DEBUG: node tree exists: ${!!defNode.tree}`);
            throw e;
        }

        if (!name) return [];

        const refs = [];
        try {
            const q = this.createQuery('[(identifier) (field_identifier)] @id');
            const matches = q.matches(this.mainTree.rootNode);
            for (const m of matches) {
                const idNode = m.captures[0].node;
                if (idNode.text === name) {
                    refs.push(idNode);
                }
            }
        } catch (e) {
            console.error(`DEBUG: findReferences main query failed for name ${name}: ${e.message}`);
            console.error(`DEBUG: mainTree exists: ${!!this.mainTree}`);
            console.error(`DEBUG: mainTree.rootNode exists: ${!!(this.mainTree && this.mainTree.rootNode)}`);
            throw e;
        }
        return refs;
    }

    /**
     * Mark a node as visited to avoid infinite recursion.
     * @param {any} key - The namespace key (transform function or macro name).
     * @param {import('tree-sitter').SyntaxNode} node - The node to visit.
     * @returns {boolean} True if new visit, False if already visited.
     */
    visit(key, node) {
        if (!node) return false;
        if (!this.visitedNodes.has(key)) {
            this.visitedNodes.set(key, new Set());
        }
        const set = this.visitedNodes.get(key);
        if (set.has(node.id)) {
            this.stats.visitsAvoided++;
            return false;
        }
        this.stats.visitsAllowed++;
        set.add(node.id);
        return true;
    }

    /**
     * Check if a node has been visited.
     * @param {any} key - The namespace key.
     * @param {import('tree-sitter').SyntaxNode} node - The node to check.
     * @returns {boolean} True if visited.
     */
    isVisited(key, node) {
        if (!node) return false;
        if (!this.visitedNodes.has(key)) return false;
        return this.visitedNodes.get(key).has(node.id);
    }


    /**
     * Resolves an include path using the configured include paths.
     * @param {string} importPath - The path from the #include directive.
     * @returns {string|null} The absolute path if found, or null.
     */
    resolveInclude(importPath) {
        if (path.isAbsolute(importPath)) {
             return fs.existsSync(importPath) ? importPath : null;
        }

        const includePaths = this.config.includePaths || [process.cwd()];
        for (const searchPath of includePaths) {
            const candidate = path.resolve(searchPath, importPath);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Loads a dependency file, pre-processes it, and extracts macros.
     * Also recursively compiles .hup files to .h files for C compiler compatibility.
     * @param {string} filePath - Absolute path to the dependency.
     */
    loadDependency(filePath) {
        // console.log(`loadDependency called on registry ${this.uid} for ${filePath}`);
        if (this.loadedDependencies.has(filePath)) return;
        this.loadedDependencies.add(filePath);

        // Check cache first
        if (this.cache && this.cache.has(filePath)) {
            const cached = this.cache.get(filePath);
            for (const [name, macro] of cached.macros) {
                if (!this.macros.has(name)) {
                    this.macros.set(name, macro);
                }
            }
            // Even if cached, we might need to regenerate the .h file if it's missing?
            // Or assume cache implies file exists?
            // Safer to check existence and regenerate if missing, but for now specific flow overrides cache?
            // Let's assume strict build: if calling loadDependency, usually we process.
            // But strict caching might skip this.
            // We'll proceed to loading macros from cache, but check if .h generation is needed.
            // Usually cache is valid only if file hasn't changed.
            // But output .h might be deleted?
            // Let's regenerate .h always if it's a .hup file, to be safe.
        }

        try {
            // Use pre-processor if configured (for .hup files)
            let source;
            if (this.config.preprocess) {
                try {
                    source = this.config.preprocess(filePath);
                } catch (e) {
                    console.error(`Preprocessing failed for ${filePath}: ${e.message}`);
                    source = fs.readFileSync(filePath, 'utf8'); // Fallback?
                }
            } else {
                source = fs.readFileSync(filePath, 'utf8');
            }

            // Scan macros fresh
            const fileMacros = this.scanMacros(source, filePath);

            // Update current registry
            for (const [name, macro] of fileMacros) {
                 if (!this.macros.has(name)) {
                     this.macros.set(name, macro);
                 }
            }

            // Header Generation Logic (.hup -> .h)
            if (filePath.endsWith('.hup')) {
                const outputPath = filePath.slice(0, -4) + '.h';

                // We need to fully expand the file to generate the .h content.
                // We use a temporary child registry for this context.
                // It inherits from 'this' so it can see macros we just loaded (and others in scope).
                // Actually, if we just loaded macros into 'this', the child will see them.
                const tempRegistry = new Registry(this.config, this);

                // Register source and process
                tempRegistry.registerSource(source, filePath);
                // process() will expand macros (like @package) and strip definitions.
                const output = tempRegistry.process();

                fs.writeFileSync(outputPath, output);
            }

            // 6. Evaluate top-level invocations for side effects (like @include in the header itself)
            // Note: registerSource + process() above ALREADY processed invocations for the .h output.
            // Do we need to process them for 'this' registry?
            // Only if they have side effects on 'this' (e.g. defining macros via invoke?).
            // @include is handled by `process()` calling `loadDependency`.
            // Since we processed it in `tempRegistry`, any `@include`s there triggered `tempRegistry.loadDependency`,
            // which recursively loaded macros into `tempRegistry`.
            // But those macros are NOT in `this` registry!
            // Wait. `tempRegistry` has parent `this`.
            // New macros defined in `tempRegistry` stay in `tempRegistry`?
            // Registry logic: `macros` map is local.
            // So implicit dependencies (macros defined in included files) are NOT propagated up!
            // This is a problem if `async.hup` includes `other.hup` and needs `other`'s macros.
            // The fix: We must explicitly propagate loaded dependencies/macros from the temp traversal?
            // OR, we just replicate the old logic: evaluate invocations on the *current* registry too?

            // Standard approach:
            // 1. We scanned definitions (top-level @define) and put them in `this`.
            // 2. We need to run top-level side-effects (like @include) in `this` context.
            const tree = this._parse(source);
            const invocations = this.findInvocations(tree, source);
            if (invocations.length > 0) {
                 // We evaluate them in `this` context to propagate side effects (like transforms or loaded macros)
                 // to the current registry.
                 const depHelpers = new UppHelpersC(this);
                 this.evaluateMacros(invocations, source, depHelpers, false, filePath);
            }

            // Update cache
            if (this.cache) {
                this.cache.set(filePath, { macros: fileMacros, includes: [] });
            }

        } catch (err) {
            console.error(`Failed to load dependency ${filePath}: ${err.message}`);
        }
    }
}

export { Registry };
