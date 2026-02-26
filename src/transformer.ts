import path from 'path';
import { UppHelpersC } from './upp_helpers_c.ts';
import { UppHelpersBase } from './upp_helpers_base.ts';
import { SourceTree, SourceNode } from './source_tree.ts';
import type { Registry, RegistryContext, Invocation, Macro, PendingRule } from './registry.ts';
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

        const { cleanSource, invocations: foundInvs } = registry.prepareSource(source, originPath);

        // Rebuild tree with clean source if macros/includes were stripped
        if (cleanSource !== source) {
            registry.tree = new SourceTree<any>(cleanSource || "", registry.language as any);
            if (registry.helpers) registry.helpers.root = registry.tree.root;
        }
        const sourceTree = registry.tree!;

        // Final helpers instance: fresh root, correct parentHelpers chain
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
            pendingRules: registry.pendingRules
        };

        if (!sourceTree) throw new Error("Could not create source tree for transformation.");
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

        this.transformNode(sourceTree.root, helpers, context);
        this.evaluatePendingRules([sourceTree.root], helpers, context);

        return sourceTree.source;
    }

    /**
     * Recursively transforms an AST node by evaluating macros and transformation rules.
     */
    transformNode(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext, force: boolean = false): void {
        if (!node || node.startIndex === -1) return;

        if (context.transformStack.has(node)) return;
        if (!force && context.transformed.has(node)) return;

        context.transformStack.add(node);
        try {
            helpers.contextNode = node;
            helpers.lastConsumedNode = null;

            // 1. Macro invocation comments (wrapped by prepareSource)
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
                        }, (context.tree as any).source, helpers, context.originPath);

                        if (result !== undefined) {
                            const isNode = result instanceof SourceNode;
                            const isArray = Array.isArray(result);

                            let finalResult = result;
                            if (!isNode && !isArray) {
                                finalResult = (result === null) ? "" : String(result);
                                if (typeof finalResult === 'string' && finalResult.includes('@')) {
                                    const prepared = this.registry.prepareSource(finalResult, context.originPath);
                                    finalResult = prepared.cleanSource;
                                }
                            }

                            const newNodes = helpers.replace(node, finalResult);

                            if (newNodes) {
                                const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                this.evaluatePendingRules(list, helpers, context);
                            }

                            if (Array.isArray(newNodes)) {
                                for (const newNode of newNodes) {
                                    if (newNode instanceof SourceNode) {
                                        const wasInStack = context.transformStack.has(newNode);
                                        if (wasInStack && newNode === node) context.transformStack.delete(newNode);
                                        this.transformNode(newNode, helpers, context, true);
                                        if (wasInStack && newNode === node) context.transformStack.add(newNode);
                                    }
                                }
                            } else if (newNodes instanceof SourceNode) {
                                const wasInStack = context.transformStack.has(newNodes);
                                if (wasInStack && newNodes === node) context.transformStack.delete(newNodes);
                                this.transformNode(newNodes, helpers, context, true);
                                if (wasInStack && newNodes === node) context.transformStack.add(newNodes);
                            }
                        }
                        return;
                    }
                }
            }

            // 2. Pending rules (eager pass during walk)
            for (const rule of [...context.pendingRules]) {
                try {
                    if (rule.matcher(node, helpers)) {
                        let applied = context.appliedRules.get(node);
                        if (!applied) {
                            applied = new Set();
                            context.appliedRules.set(node, applied);
                        }
                        if (applied.has(rule.id)) continue;
                        applied.add(rule.id);

                        const result = rule.callback(node, helpers);
                        if (result !== undefined) {
                            const newNodes = helpers.replace(node, result);
                            helpers.clearSemanticCaches?.();
                            if (newNodes) {
                                const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                for (const newNode of list) {
                                    if (newNode instanceof SourceNode) {
                                        helpers.walk(newNode, (child) => {
                                            let app = context.appliedRules.get(child);
                                            if (!app) { app = new Set(); context.appliedRules.set(child, app); }
                                            app.add(rule.id);
                                        });
                                        const wasInStack = context.transformStack.has(newNode);
                                        if (wasInStack && newNode === node) context.transformStack.delete(newNode);
                                        this.transformNode(newNode, helpers, context, true);
                                        if (wasInStack && newNode === node) context.transformStack.add(newNode);
                                    }
                                }
                            }
                        }
                        if (node.startIndex === -1) return;
                    }
                } catch (e: any) {
                    console.warn(`[upp] pendingRule failed on ${node.type}: ${e.message}`);
                }
            }

            // 4. Recursive stable walk
            for (const child of [...node.children]) {
                this.transformNode(child, helpers, context);
            }
        } finally {
            context.transformStack.delete(node);
            context.transformed.add(node);
        }

        // Post-walk: pick up any newly inserted siblings
        let hasNewSiblings = true;
        while (hasNewSiblings) {
            hasNewSiblings = false;
            for (const child of node.children) {
                if (child.startIndex !== -1 && !context.transformed.has(child) && !context.transformStack.has(child)) {
                    this.transformNode(child, helpers, context);
                    hasNewSiblings = true;
                    break;
                }
            }
        }
    }

    /**
     * Fixed-point evaluation of pending rules over newly inserted subtrees.
     */
    private evaluatePendingRules(nodes: SourceNode<any>[], helpers: UppHelpersBase<any>, context: RegistryContext): void {
        if (!nodes || nodes.length === 0) return;
        if (context.pendingRules.length === 0) return;

        let iterations = 0;
        const MAX_ITERATIONS = 5;
        let currentNodes = [...nodes];

        while (currentNodes.length > 0 && iterations < MAX_ITERATIONS) {
            iterations++;
            context.mutated = false;
            helpers.clearSemanticCaches?.();

            let sweepMutated = false;
            const nextNodes: SourceNode<any>[] = [];

            for (const node of currentNodes) {
                if (node.startIndex === -1) continue;

                const descendants: SourceNode<any>[] = [];
                helpers.walk(node, (d) => descendants.push(d));
                descendants.sort((a, b) => {
                    if (b.startIndex !== a.startIndex) return b.startIndex - a.startIndex;
                    return b.endIndex - a.endIndex;
                });

                for (const descendant of descendants) {
                    if (descendant.startIndex === -1) continue;

                    for (const rule of context.pendingRules) {
                        if (!rule.matcher) continue;

                        let applied = context.appliedRules.get(descendant);
                        if (!applied) {
                            applied = new Set();
                            context.appliedRules.set(descendant, applied);
                        }
                        if (applied.has(rule.id)) continue;

                        if (rule.matcher(descendant, helpers)) {
                            applied.add(rule.id);
                            helpers.contextNode = descendant;
                            helpers.lastConsumedNode = null;
                            const result = rule.callback(descendant, helpers);

                            if (result !== undefined) {
                                const replacementNodes = helpers.replace(descendant, result);
                                sweepMutated = true;
                                if (replacementNodes) {
                                    const list = Array.isArray(replacementNodes) ? replacementNodes : [replacementNodes];
                                    for (const newNode of list) {
                                        if (newNode instanceof SourceNode) {
                                            helpers.walk(newNode, (child) => {
                                                let app = context.appliedRules.get(child);
                                                if (!app) { app = new Set(); context.appliedRules.set(child, app); }
                                                app.add(rule.id);
                                            });
                                            nextNodes.push(newNode);
                                            this.transformNode(newNode, helpers, context, true);
                                        }
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }

            if (nextNodes.length > 0) {
                currentNodes = nextNodes;
            } else if (sweepMutated || context.mutated) {
                currentNodes = [...nodes];
                if (iterations > 5) break;
            } else {
                currentNodes = [];
            }
        }

        if (iterations >= MAX_ITERATIONS) {
            console.warn("MAX_ITERATIONS reached in evaluatePendingRules (possible infinite rule loop)");
        }
    }

    /**
     * Evaluates a single macro invocation and returns the result.
     */
    evaluateMacro(invocation: Invocation, source: string, helpers: UppHelpersBase<any>, filePath: string): MacroResult {
        const registry = this.registry;
        const macro = registry.getMacro(invocation.name);

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;
        const oldActiveNode = registry.activeTransformNode;

        try {
            if (!macro) throw new Error(`Macro @${invocation.name} not found`);

            const invocationNode = invocation.invocationNode!;
            const contextNode = helpers.contextNode || invocationNode;

            helpers.invocation = { ...invocation, invocationNode };
            helpers.contextNode = contextNode;
            helpers.lastConsumedNode = null;
            registry.activeTransformNode = invocationNode;

            const upp = Object.create(helpers);
            upp.registry = registry;
            upp.parentHelpers = registry.parentHelpers;
            upp.path = path;
            upp.invocation = { ...invocation, invocationNode };

            const macroFn = this.createMacroFunction(macro);
            const args: (string | SourceNode<any>)[] = [...invocation.args];
            let isTransformer = false;
            if (macro.params.length > 0 && macro.params[0] === 'node') {
                args.unshift(contextNode);
                isTransformer = true;
            }

            const hasRest = macro.params.length > 0 && macro.params[macro.params.length - 1].startsWith('...');
            if (!hasRest && args.length !== macro.params.length) {
                throw new Error(`@${invocation.name} expected ${isTransformer ? macro.params.length - 1 : macro.params.length} arguments, found ${invocation.args.length}`);
            }
            if (hasRest && args.length < macro.params.length - 1) {
                throw new Error(`@${invocation.name} expected at least ${macro.params.length - 1} arguments, found ${invocation.args.length}`);
            }

            return macroFn(upp, console, upp.code.bind(upp), ...args);
        } catch (err: any) {
            registry.diagnostics.reportError(0, `Macro @${invocation.name} failed: ${err.message}`, filePath, invocation.line || 1, invocation.col || 1, source);
            return undefined;
        } finally {
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
            registry.activeTransformNode = oldActiveNode;
        }
    }

    createMacroFunction(macro: Macro): Function {
        return this.registry.createMacroFunction(macro);
    }

    absorbInvocation(text: string, startIndex: number): { name: string; args: string[] } | null {
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
}
