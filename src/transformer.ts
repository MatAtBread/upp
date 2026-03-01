import path from 'path';
import { UppHelpersC } from './upp_helpers_c.ts';
import { UppHelpersBase } from './upp_helpers_base.ts';
import { SourceTree, SourceNode } from './source_tree.ts';
import type { Registry, RegistryContext, Invocation, Macro } from './registry.ts';
import type { MacroResult } from './types.ts';

/**
 * Encapsulates the transformation pipeline for a single source file.
 * Registry is a pure macro/rule store; Transformer runs the AST walk.
 */
export class Transformer {
    private registry: Registry;
    constructor(registry: Registry) {
        this.registry = registry;
    }

    /**
     * Transforms preprocessed source by expanding macros and applying rules.
     * Returns the final C source string.
     */
    run(source: string, originPath: string = 'unknown', parentHelpers: UppHelpersC | null = null): string {
        const registry = this.registry;
        registry.source = source;
        if (!source) return "";

        // Initialize tree and helpers early so dependencies loaded during
        // prepareSource() can see this registry's tree via parentRegistry.
        registry.tree = new SourceTree<any>(source, registry.language as any);
        registry.tree.onMutation = () => registry.markMutated();
        registry.helpers = new UppHelpersC(registry.tree.root as any, registry, parentHelpers) as any;

        // Initial invocation processing populates macro definitions without mutating the tree
        const { cleanSource, invocations: foundInvs } = registry.prepareSource(source, originPath);

        // Rebuild tree if preprocessing mutated the raw text
        if (cleanSource !== source) {
            registry.tree = new SourceTree<any>(cleanSource || "", registry.language as any);
        }
        const sourceTree = registry.tree!;

        const helpers = new UppHelpersC(sourceTree.root as any, registry, parentHelpers) as any;

        const context: RegistryContext = {
            source: sourceTree.source,
            tree: sourceTree,
            originPath,
            invocations: foundInvs,
            helpers,
            transformed: new Set<SourceNode<any>>(),
            transformStack: new Set<SourceNode<any>>(),
            appliedRules: new WeakMap(),
            pendingRules: registry.pendingRules // Shared array reference
        };

        if (!sourceTree) throw new Error("Could not create source tree for transformation.");
        for (const [name, macro] of registry.macros.entries()) {
            const preamble = `/*@${name}`;
            const postamble = `*/`;
            registry.registerPendingRule({
                matcher: (n, h) => n.type === 'comment' && n.text.startsWith(preamble) && n.text.endsWith(postamble),
                callback: (n, h) => {
                    const invocation = this.absorbInvocation(n.text.slice(2, -2), n.startIndex + 2);
                    if (!invocation) return undefined;
                    return this.evaluateMacro({
                        ...invocation,
                        startIndex: n.startIndex,
                        endIndex: n.endIndex,
                        invocationNode: n
                    }, source, h, originPath);
                },
                contextNode: null!
            });
        }

        context.helpers = helpers;
        helpers.context = context;
        helpers.root = sourceTree.root;

        if (!registry.mainContext) {
            registry.mainContext = context;
        }

        if (parentHelpers) {
            helpers.parentHelpers = parentHelpers;
            helpers.parentRegistry = {
                invocations: parentHelpers.context?.invocations || [],
                sourceCode: parentHelpers.context?.tree?.source || parentHelpers.context?.source || "",
                helpers: parentHelpers
            };
            helpers.topLevelInvocation = (parentHelpers as any).topLevelInvocation || (parentHelpers as any).invocation;
            helpers.currentInvocations = foundInvs.length > 0 ? foundInvs : ((parentHelpers as any).currentInvocations || []);
        } else {
            helpers.currentInvocations = foundInvs;
        }

        this.transformNodeAndHandleRules(sourceTree.root, helpers, context);

        return sourceTree.source;
    }

    /**
     * Replaces `transformNode` and `evaluatePendingRules`. 
     * Handles Phase C Iterative Limits around a node.
     */
    private transformNodeAndHandleRules(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext): void {
        let iterations = 0;
        const MAX_ITERATIONS = 50;

        while (iterations < MAX_ITERATIONS) {
            iterations++;

            // If the node was deleted by a previous iteration, drop out
            if (!node.isValid) return;

            // Execute the Unified Step A & B Pipeline
            const replacedWith = this.executeExitEvaluationPipeline(node, helpers, context);

            // If nothing structurally replaced this node (meaning it just processed its rules or walked children),
            // or if it was marked as fully transformed and sealed, we break the loop organically.
            if (!replacedWith || replacedWith === node) {
                break;
            }

            // A rule Replaced the node. Phase C kicks in.
            // We must now restart the pipeline specifically on the newly generated tree fragment.
            // `replacedWith` may be a single node or an array of generated sibling nodes.
            const list = Array.isArray(replacedWith) ? replacedWith : [replacedWith];

            for (const newNode of list) {
                if (!newNode.isValid) continue;
                // Recursive call handles the newly injected nodes before we loop back
                this.transformNodeAndHandleRules(newNode, helpers, context);
                // In practice, since we recursed deeply, this outer loop rarely needs 
                // to spin unless the replacement *itself* got replaced during its climb.
            }

            // Re-eval loops automatically halt because the newly visited descendants
            // are locked inside `context.transformed` at exit.
            break;
        }

        if (iterations >= MAX_ITERATIONS) {
            console.warn(`[UPP] Maximum substitution iterations (${MAX_ITERATIONS}) reached for node of type ${node.type}. Possible infinite generation loop in a macro.`);
        }
    }

    /**
     * Follows the Strict Context-Exit Evaluation Strategy.
     * Returns a replacement Node (or array) if a rule transformed this context, 
     * otherwise returns the original node (or null if deleted).
     */
    private executeExitEvaluationPipeline(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext): SourceNode<any> | SourceNode<any>[] | null {
        if (!node || node.startIndex === -1) return null;
        if (context.transformed.has(node)) return node;

        // --- Phase A: Deep Descent ---
        // Lock this node as "ReadOnly Ancestor" during its children's descent.
        node.isReadOnly = true;

        for (const child of node.walkChildren()) {
            this.transformNodeAndHandleRules(child, helpers, context);
        }

        node.isReadOnly = false;

        // --- Phase B: Evaluation (Exit of the specific Node) ---
        helpers.contextNode = node;
        helpers.lastConsumedNode = null;
        context.transformed.add(node); // Mark as processed to guard against infinite recursion if generated nodes match pending rules

        // 1. Implicit Macro Invocations are now removed; they are standard Rules.
        // 2. Execute Pending Rules bound to this node
        let nodeResult: SourceNode<any> | SourceNode<any>[] | null = node;

        const boundRules = context.pendingRules.filter(r => r.contextNode === node || r.contextNode === null);
        if (boundRules.length > 0) {
            const applyRulesPostOrder = (currentNode: SourceNode<any>): SourceNode<any> | SourceNode<any>[] | null => {
                if (!currentNode || currentNode.startIndex === -1) return null;

                // Deep descent over children first to maintain bottom-up application
                for (const child of currentNode.walkChildren()) {
                    applyRulesPostOrder(child);
                }

                if (currentNode.startIndex === -1) return null; // In case it was deleted by a child expansion

                let currentResult: SourceNode<any> | SourceNode<any>[] | null = currentNode;
                for (let i = 0; i < boundRules.length; i++) {
                    const rule = boundRules[i];
                    let applied = context.appliedRules.get(currentNode);
                    if (!applied) {
                        applied = new Set();
                        context.appliedRules.set(currentNode, applied);
                    }

                    try {
                        const isMatch = rule.matcher(currentNode, helpers);
                        if (isMatch && !applied.has(rule.id)) {
                            applied.add(rule.id);

                            const oldContext = helpers.contextNode;
                            helpers.contextNode = currentNode;
                            const res = rule.callback(currentNode, helpers);
                            helpers.contextNode = oldContext;

                            if (res !== undefined) {
                                if (res === null) {
                                    currentNode.remove();
                                } else {
                                    currentResult = helpers.replace(currentNode, res);
                                    helpers.clearSemanticCaches?.();
                                    if (currentResult !== currentNode) break;
                                }
                            }
                        }
                    } catch (e: any) {
                        console.warn(`[upp] pendingRule failed on descendant of ${node.type}: ${e.message}`);
                    }
                }
                return currentResult;
            };

            nodeResult = applyRulesPostOrder(node);
        }

        return nodeResult;
    }

    /**
     * Parses a macro invocation string.
     */
    private absorbInvocation(text: string, startIndex: number): { name: string, args: string[] } | null {
        text = text.trim();
        const match = text.match(/^@?([a-zA-Z0-9_]+)\s*(\(.*\))?$/);
        if (!match) return null;

        const name = match[1];
        const argsStr = match[2]?.slice(1, -1);
        const args: string[] = [];

        if (argsStr?.trim()) {
            let depth = 0;
            let current = "";
            let inString = false;
            let escape = false;

            for (let i = 0; i < argsStr.length; i++) {
                const char = argsStr[i];
                if (escape) {
                    current += char;
                    escape = false;
                    continue;
                }

                if (char === '\\') {
                    escape = true;
                    current += char;
                    continue;
                }

                if (char === '"') {
                    inString = !inString;
                    current += char;
                    continue;
                }

                if (!inString) {
                    if (char === '(' || char === '{' || char === '[') depth++;
                    else if (char === ')' || char === '}' || char === ']') depth--;
                    else if (char === ',' && depth === 0) {
                        args.push(current);
                        current = "";
                        continue;
                    }
                }
                current += char;
            }
            args.push(current);
        }

        return { name, args };
    }

    /**
     * Evaluates a macro invocation.
     */
    private evaluateMacro(invocation: Invocation, source: string, helpers: UppHelpersBase<any>, filePath: string): MacroResult | undefined {
        const macroDef = this.registry.getMacro(invocation.name);
        if (!macroDef) {
            console.warn(`[UPP] Macro '${invocation.name}' not found.`);
            return undefined;
        }

        const args = invocation.args.map(a => {
            const trimmed = a.trim();
            if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
                return trimmed.slice(1, -1); // Unquote strings
            }
            return a;
        });

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;
        const oldActiveNode = this.registry.activeTransformNode;

        try {
            const invocationNode = invocation.invocationNode!;
            const contextNode = helpers.contextNode || invocationNode;

            helpers.invocation = { ...invocation, invocationNode };
            helpers.contextNode = contextNode;
            helpers.lastConsumedNode = null;
            this.registry.activeTransformNode = invocationNode;

            const upp = Object.create(helpers);
            upp.registry = this.registry;
            upp.parentHelpers = this.registry.parentHelpers;
            upp.path = path;
            upp.invocation = { ...invocation, invocationNode };

            const macroFn = this.createMacroFunction(macroDef);
            let callArgs: any[] = [...args];
            let isTransformer = false;

            if (macroDef.params.length > 0 && macroDef.params[0] === 'node') {
                callArgs.unshift(contextNode);
                isTransformer = true;
            }

            const hasRest = macroDef.params.length > 0 && macroDef.params[macroDef.params.length - 1].startsWith('...');
            if (!hasRest && callArgs.length !== macroDef.params.length) {
                throw new Error(`@${invocation.name} expected ${isTransformer ? macroDef.params.length - 1 : macroDef.params.length} arguments, found ${args.length}`);
            }

            return macroFn(upp, console, upp.code.bind(upp), ...callArgs);
        } catch (e: any) {
            console.error(`[UPP] Error evaluating macro '${invocation.name}' at ${filePath}:`, e);
            throw e; // Rethrow to halt transformation
        } finally {
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
            this.registry.activeTransformNode = oldActiveNode;
        }
    }

    /**
     * Creates a macro function from definition.
     */
    createMacroFunction(macro: Macro): Function {
        return this.registry.createMacroFunction(macro);
    }
}
