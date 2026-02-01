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
    constructor(config = {}) {
        /** @type {Object} */
        this.config = config;
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
    }

    /**
     * internal helper - parses source code string to tree
     * @private
     * @param {string} source - Source code to parse.
     * @returns {import('tree-sitter').Tree} Tree-sitter tree.
     */
    _parse(source) {
        if (typeof source !== 'string') {
            return this.parser.parse("");
        }
        return this.parser.parse(source);
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
            if (node.type === 'comment') return;
            if (node.type === 'ERROR') {
                const nodeText = node.text.trim();
                if (nodeText === '@' || nodeText.startsWith('@')) {
                    if (!seenIndices.has(node.startIndex) && !this.isInsideDefinition(node.startIndex, source)) {
                        const invocation = this.absorbInvocation(source, node.startIndex);
                        if (invocation && this.macros.has(invocation.name)) {
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
        this.allTrees = [];
        let iterations = 0;
        const maxIterations = 100;

        if (typeof this.sourceCode !== 'string') {
             console.error("CRITICAL: process() called without valid sourceCode. Type:", typeof this.sourceCode);
             this.sourceCode = "";
        }

        // Pre-process includes
        this.processIncludes();

        while (iterations < maxIterations) {
            const cleanSource = this.maskDefinitions(this.sourceCode);
            if (typeof cleanSource !== 'string') {
                 console.error("CRITICAL: maskDefinitions returned non-string. Type:", typeof cleanSource);
                 break;
            }
            this.mainTree = this._parse(cleanSource);
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
            this.helpers.replacements = [];
            this.evaluateMacros(this.invocations, this.sourceCode, this.helpers, true, this.filePath);

            // At this point, this.mainTree has been set to this.cleanTree by evaluateMacros

            // At this point, this.mainTree has been set to this.cleanTree by evaluateMacros
            // this.mainTree is the clean tree (stripped macros).

            this.applyTransforms(this.cleanTree, this.helpers);

            this.applyChanges(this.invocations);
            this.cleanTree = null;
            iterations++;
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
            if (invocation.skipped) continue;
            const macro = this.macros.get(invocation.name);
            if (!macro) continue;

            const lastParam = macro.params[macro.params.length - 1];
            const hasRestParam = lastParam && lastParam.startsWith('...');
            const expectedArgs = macro.params.length;

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
     * Scans source code for include directives.
     * @param {string} source - Source code to scan.
     * @returns {Array<string>} List of imported paths.
     */
    scanIncludes(source) {
        // Regex matches .upp, .hup, .cup
        const includeRegex = /^\s*#\s*include\s*"([^"]+\.(?:upp|hup|cup))"/gm;
        const includes = [];
        let match;
        while ((match = includeRegex.exec(source)) !== null) {
            includes.push(match[1]);
        }
        return includes;
    }

    /**
     * run registered transforms on the tree
     * @param {import('tree-sitter').Tree} tree - The AST.
     * @param {Object} helpers - The helpers instance.
     */
    applyTransforms(tree, helpers) {
        helpers.root = tree.rootNode || tree;
        for (const transform of this.transforms) {
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
            `).matches(this.mainTree.rootNode);

            for (const m of matches) {
                const idNode = m.captures[0].node;
                if (idNode.text === name && idNode.startIndex <= node.startIndex) {
                    // Return the parent declaration/parameter
                    let p = this.helpers.parent(idNode);
                    while (p && p.type !== 'declaration' && p.type !== 'parameter_declaration') {
                        p = this.helpers.parent(p);
                    }
                    def = p || idNode;
                }
            }
        } catch (e) {
            console.error(`DEBUG: getDefinition query failed for node ${node.type} (${node.text}): ${e.message}`);
            throw e;
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
     * Scans for #include "foo.upp" directives, loads macros, and rewrites to "foo".
     */
    processIncludes() {
        const includeRegex = /^\s*#\s*include\s*"([^"]+\.(?:upp|hup|cup))"/gm;
        let match;
        const replacements = [];

        while ((match = includeRegex.exec(this.sourceCode)) !== null) {
            const fullMatch = match[0];
            const importPath = match[1];
            const start = match.index;
            const end = start + fullMatch.length;

            // Resolve and load
            const resolvedPath = this.resolveInclude(importPath);
            if (resolvedPath) {
                this.loadDependency(resolvedPath);

                // Rewrite: remove .upp from the import path in the source
                // The importPath is group 1. We want to replace the whole line or just the path?
                // Replacing the path inside the quotes is safest.
                // Reconstruct the line without .upp
                const ext = path.extname(importPath);
                // remove .upp or .hup/.cup extension if present?
                // Logic: .hup -> .h, .cup -> .c, .upp -> remove (basename)
                let newPath;
                if (importPath.endsWith('.hup')) newPath = importPath.slice(0, -2); // .hup -> .h
                else if (importPath.endsWith('.cup')) newPath = importPath.slice(0, -2); // .cup -> .c
                else if (importPath.endsWith('.upp')) newPath = importPath.slice(0, -4); // .upp -> remove
                else newPath = importPath; // fallback

                const replacement = fullMatch.replace(importPath, newPath);

                replacements.push({ start, end, replacement });
            } else {
                // Determine line/col for warning
                const { line, col } = DiagnosticsManager.getLineCol(this.sourceCode, start);
                this.diagnostics.reportWarning(
                    DiagnosticCodes.MISSING_INCLUDE,
                    `Could not resolve include: ${importPath}`,
                    this.filePath,
                    line,
                    col,
                    this.sourceCode
                );
            }
        }

        // Apply replacements in reverse
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            this.sourceCode = this.sourceCode.slice(0, r.start) + r.replacement + this.sourceCode.slice(r.end);
        }
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
     * Loads a dependency file and extracts macros.
     * @param {string} filePath - Absolute path to the dependency.
     */
    loadDependency(filePath) {
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
            // Populate recursive includes from cache if available
            if (cached.includes) {
                for (const inc of cached.includes) {
                    const resolved = this.resolveInclude(inc);
                    if (resolved) this.loadDependency(resolved);
                }
                return;
            }
        }

        try {
            const source = fs.readFileSync(filePath, 'utf8');

            // If -w is enabled, we need to generate the output for this dependency too.
            // This is "recursive compilation".
            if (this.config.write) {
                // Determine output path: remove .upp extension
                let outPath = null;
                if (filePath.endsWith('.hup')) {
                    outPath = filePath.slice(0, -2);
                } else if (filePath.endsWith('.cup')) {
                    outPath = filePath.slice(0, -2);
                } else if (filePath.endsWith('.upp')) {
                    outPath = filePath.slice(0, -4);
                }

                if (outPath) {
                    // Avoid infinite recursion or double writing?
                    // The cache check above handles "loading" recursion.
                    // But if we are here, it wasn't cached, so we write it once.
                    // We need a fresh registry for the dependency to process it fully.
                    // We share the SAME cache.
                    const subRegistry = new Registry(this.config);
                    subRegistry.registerSource(source, filePath);
                    const output = subRegistry.process();
                    fs.writeFileSync(outPath, output);
                    // console.log(`Recursively generated: ${path.relative(process.cwd(), outPath)}`);
                }
            }

            // Scan macros fresh
            const fileMacros = this.scanMacros(source, filePath);

            // Update current registry
            for (const [name, macro] of fileMacros) {
                 if (!this.macros.has(name)) {
                     this.macros.set(name, macro);
                 }
            }

            const includes = this.scanIncludes(source);

            // Recursive scan for includes to load transitive macros
            for (const subImport of includes) {
                const resolved = this.resolveInclude(subImport);
                if (resolved) {
                    this.loadDependency(resolved);
                }
            }

            // Evaluate top-level invocations in the dependency (for side effects like registerTransform)
            const tree = this._parse(source);
            const invocations = this.findInvocations(tree, source);
            if (invocations.length > 0) {
                 const depHelpers = new UppHelpersC(this);
                 this.evaluateMacros(invocations, source, depHelpers, false, filePath);
                 // We discard depHelpers.replacements because we are not generating code for the dependency here
                 // (unless -w path above handled it, but that uses a separate registry instance).
                 // We only want the side effects on 'this.transforms' etc.
            }

            // Update cache
            if (this.cache) {
                this.cache.set(filePath, { macros: fileMacros, includes });
            }

        } catch (err) {
            console.error(`Failed to load dependency ${filePath}: ${err.message}`);
        }
    }
}

export { Registry };
