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

        /** @type {string|null} */
        this.activeMacro = null;
        this.activeMacroInvocation = null;

        // Marker System (for deferred transformations and code replacement)
        /** @type {Map<string, string>} - Maps marker strings to replacement content */
        this.markerMap = new Map();
        /** @type {number} - Counter for generating unique marker IDs */
        this.markerCounter = 0;

        // Deferred Callback System (for nested macro scope resolution)
        /** @type {Map<string, {callback: function, targetType: string, context: Object}>} */
        this.deferredCallbacks = new Map();
        /** @type {number} - Counter for generating unique deferred marker IDs */
        this.deferredCounter = 0;

        // Transformation Rule Tracking (for composable macros)
        /** @type {Array<Object>} - Active transformation rules */
        this.transformRules = [];
        /** @type {number} - Counter for generating unique rule IDs */
        this.ruleIdCounter = 0;

        this.transformDepth = 0;
        /** @type {import('tree-sitter').SyntaxNode|null} */
        this.activeTransformNode = null;
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
        const transformId = Math.random().toString(36).substring(7);
        const { cleanSource, invocations: foundInvs } = this.prepareSource(source);
        const tree = this._parse(cleanSource);
        if (!tree) return source;
        const isMain = !this.mainTree || originPath === this.filePath;
        if (isMain) {
            this.mainTree = tree;
            this.markerMap.clear();
            this.markerCounter = 0;
            // Use foundInvs which has wrappedStartIndex, not findInvocations(source)
            this.invocations = foundInvs;
        }

        const helpers = isMain ? this.helpers : new UppHelpersC(this);
        if (parentHelpers) {
            helpers.topLevelInvocation = parentHelpers.topLevelInvocation || parentHelpers.invocation;
        }
        // Use foundInvs which has wrappedStartIndex
        // If foundInvs is empty (nested transform), inherit from parent
        const invocationsToUse = foundInvs.length > 0 ? foundInvs : (parentHelpers?.currentInvocations || []);
        helpers.root = tree.rootNode;
        helpers.currentInvocations = invocationsToUse;
        helpers.transformId = transformId;

        return this.transformNode(tree.rootNode, cleanSource, helpers, originPath);
    }

    transformNode(node, source, helpers, originPath) {
        if (!node) return "";
        if (helpers.isConsumed(node)) return "";

        if (node.type === 'comment') {
            console.log(`[DEBUG] Found comment node: "${node.text.substring(0, 40)}"`);
        }

        const oldActive = this.activeTransformNode;
        this.activeTransformNode = node;
        try {
            // Check if this is a comment node with a macro invocation
            if (node.type === 'comment' && node.text.startsWith('/*@') && node.text.endsWith('*/')) {
                // Extract the macro invocation from the comment
                const commentText = node.text.slice(2, -2); // Remove /* and */

                // Parse the macro name from the comment text
                const match = commentText.match(/^@(\w+)/);
                if (match) {
                    const macroName = match[1];
                    const macro = this.getMacro(macroName);

                    if (macro) {
                        // Parse the arguments from the comment
                        const argsMatch = commentText.match(/^@\w+\((.*)\)/);
                        const argsText = argsMatch ? argsMatch[1] : '';
                        const args = argsText ? argsText.split(',').map(s => s.trim()) : [];

                        // Create a synthetic invocation object
                        const invocation = {
                            name: macroName,
                            args: args,
                            startIndex: node.startIndex,
                            endIndex: node.endIndex,
                            line: 0, // TODO: calculate from position
                            col: 0,
                            invocationNode: node // Pass the comment node so evaluateMacro can find next sibling
                        };

                        // Evaluate the macro
                        const result = this.evaluateMacro(invocation, source, helpers, originPath);
                        // Transform the result and return it (this will replace the comment)
                        return this.transform(result, `result-of-@${macroName}`, helpers);
                    }
                }
            }

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

            // Process deferred callback markers - only at scope boundaries
            if (combined.includes('__UPP_DEFERRED_') &&
                (node.type === 'compound_statement' || node.type === 'translation_unit')) {
                console.log(`[transformNode] Found deferred markers in SCOPE ${node.type}, combined length=${combined.length}`);
                for (const [markerId, taskInfo] of this.deferredCallbacks.entries()) {
                    if (combined.includes(markerId)) {
                        console.log(`[transformNode] Processing marker ${markerId} at ${node.type}, targetType=${taskInfo.targetType}`);
                        // Found a deferred marker - find the appropriate scope to execute at
                        let targetNode = null;

                        if (taskInfo.targetType === 'root') {
                            // Use the main tree's root node, not the marker's ancestor
                            // The marker might be in an isolated tree (e.g., from macro result transformation)
                            targetNode = this.mainTree ? this.mainTree.rootNode : null;
                            if (!targetNode) {
                                // Fallback: walk up to translation_unit
                                let current = node;
                                while (current && current.type !== 'translation_unit') {
                                    current = current.parent;
                                }
                                targetNode = current;
                            }
                        } else if (taskInfo.targetType === 'scope') {
                            // Find the compound_statement ancestor
                            let current = node;
                            while (current && current.type !== 'compound_statement') {
                                current = current.parent;
                            }
                            targetNode = current;
                        }

                        console.log(`[transformNode] targetNode: ${targetNode ? targetNode.type : 'NULL'}`);
                        if (targetNode) {
                            try {
                                // Create a new helpers instance with the correct scope
                                const scopedHelpers = new UppHelpersC(this);
                                scopedHelpers.root = targetNode;
                                scopedHelpers.invocation = taskInfo.context.invocation;
                                scopedHelpers.contextNode = taskInfo.context.contextNode;

                                // Execute the callback
                                console.log(`[transformNode] Executing deferred callback for ${markerId}`);
                                taskInfo.callback(targetNode, scopedHelpers);

                                // If cleanup code was stored, insert it directly into combined string
                                if (taskInfo.cleanupCode) {
                                    console.log(`[transformNode] Inserting cleanup code into combined string`);

                                    // Insert before all return statements
                                    if (taskInfo.insertBeforeReturns) {
                                        combined = combined.replace(/(\breturn\b)/g, `${taskInfo.cleanupCode} $1`);
                                    }

                                    // Insert before closing brace at end of scope
                                    if (taskInfo.insertAtScopeEnd) {
                                        const lastBraceIdx = combined.lastIndexOf('}');
                                        if (lastBraceIdx !== -1) {
                                            combined = combined.slice(0, lastBraceIdx) + taskInfo.cleanupCode + ' ' + combined.slice(lastBraceIdx);
                                        }
                                    }
                                }

                                // Remove the marker from output
                                combined = combined.split(markerId).join('');

                                // Remove from callbacks map
                                this.deferredCallbacks.delete(markerId);
                            } catch (e) {
                                console.error(`Deferred callback execution failed for ${markerId}: ${e.message}`);
                                console.error(e.stack);
                            }
                        }
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
            invocationNode = invocation.invocationNode || helpers.root.descendantForIndex(invocation.startIndex, invocation.endIndex);
        } catch (e) {
            console.log(`DEBUG: evaluateMacro failed to get invocationNode for @${invocation.name} at ${invocation.startIndex}`);
        }

        let contextNode = invocationNode;

        // Special handling for comment-wrapped macros
        if (contextNode && contextNode.type === 'comment') {
            // For comment nodes, the code to consume is the next sibling
            contextNode = contextNode.nextSibling;
        } else if (contextNode && (
            contextNode.type === 'translation_unit' ||
            contextNode.type === 'compound_statement' ||
            contextNode === helpers.root
        )) {
             // When in a nested context, we need to use the invocation from currentInvocations
             // because invocation.endIndex is from the parent source, not the current tree
             const isNestedContext = helpers.root && this.mainTree && helpers.root.id !== this.mainTree.rootNode.id;
             let searchIndex = invocation.endIndex;

             if (isNestedContext && helpers.currentInvocations) {
                 console.log(`[contextNode] Nested context detected. Looking for invocation '${invocation.name}'`);
                 console.log(`[contextNode] currentInvocations:`, helpers.currentInvocations.map(i => `${i.name}@${i.startIndex}-${i.endIndex}`));

                 // Find the matching invocation in the current tree's invocations
                 const currentInv = helpers.currentInvocations.find(inv =>
                     inv.name === invocation.name && !inv.skipped
                 );
                 console.log(`[contextNode] Found matching invocation: ${currentInv ? 'YES' : 'NO'}`);
                 if (currentInv) {
                     searchIndex = currentInv.endIndex;
                     console.log(`[contextNode] Using searchIndex=${searchIndex} from currentInv`);
                 }
             }

             console.log(`[contextNode] Searching for nextNode after index ${searchIndex} in tree with text: ${helpers.root.text.substring(0, 100)}...`);
             const nextNode = helpers.findNextNodeAfter(helpers.root, searchIndex);
             console.log(`[contextNode] findNextNodeAfter returned: ${nextNode ? `${nextNode.type} [${nextNode.startIndex}-${nextNode.endIndex}]` : 'NULL'}`);
             if (nextNode && nextNode.type !== 'translation_unit' && nextNode.id !== helpers.root.id) {
                 contextNode = nextNode;
                 console.log(`[contextNode] Set contextNode to: ${contextNode.type}`);
             } else {
                 contextNode = (invocationNode && invocationNode.type !== 'translation_unit') ? invocationNode : null;
                 console.log(`[contextNode] contextNode set to: ${contextNode ? contextNode.type : 'NULL'} (fallback)`);
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

            // Handle different return types:
            // - tree object (has .tree property): use toString()
            // - null: delete the node (return empty string)
            // - undefined: no substitution (return empty string, macro modified in-place)
            // - string: use as-is
            let output = "";
            if (result === null || result === undefined) {
                output = "";
            } else if (typeof result === 'object' && result.tree) {
                // Tree object from upp.code
                output = result.toString();
            } else if (typeof result === 'object' && result.text !== undefined) {
                // Legacy object with .text property (for backward compatibility during transition)
                output = result.text;
            } else {
                // String or other primitive
                output = String(result);
            }
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

    executeDeferredTask(combinedText, callback, originPath, originalType) {
        const isTU = originalType === 'translation_unit';
        // We wrap in a function IF it doesn't look like a full TU.
        // Most deferred tasks (like @defer) are in blocks.
        const wrappedSource = isTU ? combinedText : `void __upp_temp_func() {\n${combinedText}\n}`;
        const tempTree = this._parse(wrappedSource);
        const tempHelpers = new UppHelpersC(this);

        let targetNode = tempTree.rootNode;
        if (!isTU) {
            // Find the node that corresponds to combinedText.
            // It starts at index 25 in the wrapped source.
            let candidate = tempTree.rootNode.descendantForIndex(25, 25);
            while (candidate && candidate.parent && candidate.parent.startIndex === 25 && (candidate.parent.endIndex - 25) <= combinedText.length) {
                candidate = candidate.parent;
            }
            targetNode = candidate;
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

        // Instead of masking invocations with spaces, wrap them in comments
        // This makes the source parse as valid C while preserving macro information
        const invsToWrap = [...foundInvs].sort((a, b) => b.startIndex - a.startIndex);
        let cumulativeOffset = 0; // Track how much we've shifted positions

        for (const inv of invsToWrap) {
            const invText = cleanSource.slice(inv.startIndex, inv.endIndex);
            // Wrap in comment: @allocate(100) becomes /*@allocate(100)*/
            const wrapped = `/*${invText}*/`;
            const addedChars = wrapped.length - invText.length; // Should be 4 (/* and */)

            cleanSource = cleanSource.slice(0, inv.startIndex) + wrapped + cleanSource.slice(inv.endIndex);

            // The comment node will start at inv.startIndex in the wrapped source
            inv.wrappedStartIndex = inv.startIndex;
            inv.wrappedEndIndex = inv.startIndex + wrapped.length;
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

    /**
     * Register a deferred task to be executed when recursion reaches the target scope/root
     * @param {number} markerId - Unique marker ID
     * @param {function} callback - Callback to execute with (scope/root node, helpers)
     * @param {string} targetType - 'scope' or 'root'
     * @param {Object} capturedContext - Context captured at registration time
     */
    registerDeferredTask(markerId, callback, targetType, capturedContext) {
        this.deferredQueue.push({ markerId, callback, targetType, capturedContext });
    }

    /**
     * Check if current node matches any queued deferred tasks and execute them
     * @param {import('tree-sitter').SyntaxNode} node - Current node being processed
     * @param {UppHelpersC} helpers - Helpers instance for this transformation
     */
    checkAndExecuteDeferredTasks(node, helpers) {
        const nodeId = node.id;
        const tasksToExecute = [];
        const remainingTasks = [];

        if (this.deferredQueue.length > 0) {
            console.log(`[Queue Check] Node type=${node.type}, id=${nodeId}, queue size=${this.deferredQueue.length}`);
        }

        for (const task of this.deferredQueue) {
            const markedNodeId = this.nodeMarkers.get(task.markerId);
            console.log(`  [Task] marker=${task.markerId}, markedNodeId=${markedNodeId}, targetType=${task.targetType}`);

            if (task.targetType === 'root') {
                // Execute at translation_unit or root
                if (node.type === 'translation_unit' || node.parent === null) {
                    console.log(`    -> Executing at root`);
                    tasksToExecute.push(task);
                } else {
                    remainingTasks.push(task);
                }
            } else if (task.targetType === 'scope') {
                // Execute when we reach a compound_statement that contains the marked node
                // We need to check if this node is a scope and if it contains the marked node
                if (node.type === 'compound_statement') {
                    // Check if the marked node is a descendant of this scope
                    let current = this.findNodeById(node, markedNodeId);
                    if (current) {
                        console.log(`    -> Executing at scope (found marked node)`);
                        tasksToExecute.push(task);
                    } else {
                        console.log(`    -> Not executing (marked node not found in this scope)`);
                        remainingTasks.push(task);
                    }
                } else {
                    remainingTasks.push(task);
                }
            }
        }

        // Execute matched tasks
        for (const task of tasksToExecute) {
            try {
                // Create a new helpers instance with the correct scope
                const scopedHelpers = new UppHelpersC(this);
                scopedHelpers.root = node;
                scopedHelpers.invocation = task.capturedContext.invocation;
                scopedHelpers.contextNode = task.capturedContext.contextNode;

                task.callback(node, scopedHelpers);
            } catch (e) {
                console.error(`Deferred task execution failed: ${e.message}`);
            }
        }

        // Update queue
        this.deferredQueue = remainingTasks;
    }

    /**
     * Find a node by ID within a subtree
     * @param {import('tree-sitter').SyntaxNode} root - Root node to search from
     * @param {number} targetId - Node ID to find
     * @returns {import('tree-sitter').SyntaxNode|null}
     */
    findNodeById(root, targetId) {
        if (root.id === targetId) return root;
        for (let i = 0; i < root.childCount; i++) {
            const found = this.findNodeById(root.child(i), targetId);
            if (found) return found;
        }
        return null;
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

    // Transformation Rule Tracking Methods

    /**
     * Generate a unique ID for a transformation rule
     * @returns {string} Unique rule ID
     */
    generateRuleId() {
        return `rule_${this.ruleIdCounter++}`;
    }

    /**
     * Register a transformation rule for re-evaluation on generated code
     * @param {Object} rule - Rule object with id, type, identity, matcher, callback, scope, active
     */
    registerTransformRule(rule) {
        this.transformRules.push(rule);
    }

    /**
     * Evaluate registered transformation rules against newly generated code
     * @param {string} newCode - The newly generated code to check
     * @param {number} startPos - Starting position of the new code
     */
    evaluateRulesOnNewCode(newCode, startPos) {
        // Simplified regex-based matching for now
        // TODO: Improve to use AST matching when new code is integrated into main tree
        for (const rule of this.transformRules) {
            if (!rule.active) continue;

            if (rule.type === 'references' || rule.type === 'pattern') {
                const name = rule.identity.name || rule.identity.nodeType;
                if (name) {
                    const regex = new RegExp(`\\b${name}\\b`, 'g');
                    if (regex.test(newCode)) {
                        console.log(`[Rule ${rule.id}] Found potential match for "${name}" in generated code`);
                        // TODO: Apply transformation when AST matching is available
                    }
                }
            }
        }
    }

    /**
     * Deactivate transformation rules for a given scope
     * @param {import('tree-sitter').SyntaxNode} scope - The scope node
     */
    deactivateRulesForScope(scope) {
        for (const rule of this.transformRules) {
            if (rule.scope === scope) {
                rule.active = false;
            }
        }
    }
}

export { Registry };
