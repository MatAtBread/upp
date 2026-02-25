import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { UppHelpersC } from './upp_helpers_c.ts';
import { UppHelpersBase } from './upp_helpers_base.ts';
import { DiagnosticsManager } from './diagnostics.ts';
import { SourceTree, SourceNode } from './source_tree.ts';
import type { Tree, SyntaxNode } from 'tree-sitter';
import type { DependencyCache } from './dependency_cache.ts';


export interface Macro {
    name: string;
    params: string[];
    body: string;
    language: string;
    origin: string;
    startIndex: number;
}

export interface TransformRule<T extends string = string> {
    active: boolean;
    matcher: (node: SourceNode<T>, helpers: UppHelpersBase<any>) => boolean;
    callback: (node: SourceNode<T>, helpers: UppHelpersBase<any>) => MacroResult;
}

export interface PendingRule<T extends string = string> {
    id: number;
    contextNode: SourceNode<any>;
    matcher: (node: SourceNode<T>, helpers: UppHelpersBase<any>) => boolean;
    callback: (node: SourceNode<T>, helpers: UppHelpersBase<any>) => MacroResult;
}

export interface Invocation {
    name: string;
    args: string[];
    startIndex: number;
    endIndex: number;
    line?: number;
    col?: number;
    invocationNode?: SourceNode<any>;
}

import type { MaterializeOptions, MacroResult, Language } from './types.ts';
export type { MaterializeOptions };

export interface RegistryConfig {
    onMaterialize?: (outputPath: string, content: string, options: MaterializeOptions) => void;
    filePath?: string;
    stdPath?: string;
    includePaths?: string[];
    cache?: DependencyCache;
    diagnostics?: DiagnosticsManager;
    suppress?: string[];
    comments?: boolean;
}



export interface RegistryContext {
    source: string;
    tree: SourceTree<any>;
    originPath: string;
    invocations: Invocation[];
    helpers: UppHelpersBase<any> | null;
    transformed: Set<SourceNode<any>>;
    transformStack: Set<SourceNode<any>>;
    appliedRules: WeakMap<SourceNode<any>, Set<number>>;
    mutated?: boolean;
}

type TreeSitterLang = Language;
/**
 * Main registry class for managing macros, parsing, and transformations.
 * @class
 */
class Registry {
    public config: RegistryConfig;
    public parentRegistry: Registry | null;
    public depth: number;
    public filePath: string;
    public diagnostics: DiagnosticsManager;
    public language: TreeSitterLang; // Tree-sitter Language
    public helpers: UppHelpersBase<any> | null;
    public parentHelpers: UppHelpersBase<any> | null;
    public isAuthoritative: boolean;
    public macros: Map<string, Macro>;
    public parser: Parser;

    public stdPath: string | null;
    public includePaths: string[];
    public loadedDependencies: Map<string, string>;
    public shouldMaterializeDependency: boolean;
    public transformRules: TransformRule<any>[];
    public pendingRules: PendingRule<any>[];
    public ruleIdCounter: number;

    public mainContext: RegistryContext | null;
    public source?: string;
    public tree?: SourceTree<any>;
    public dependencyHelpers: UppHelpersBase<any>[];

    public activeTransformNode?: SourceNode<any> | null;
    public originPath?: string;

    constructor(config: RegistryConfig = {}, parentRegistry: Registry | null = null) {
        this.config = config;
        this.parentRegistry = parentRegistry;
        this.depth = parentRegistry ? parentRegistry.depth + 1 : 0;
        if (this.depth > 100) {
            throw new Error(`Maximum macro nesting depth exceeded (${this.depth})`);
        }

        this.filePath = config.filePath || '';
        this.diagnostics = config.diagnostics || new DiagnosticsManager(config);

        let lang: any = C;
        if (lang && lang.default) lang = lang.default;
        this.language = lang;

        this.helpers = null;
        this.parentHelpers = parentRegistry ? (parentRegistry.helpers || new UppHelpersC(null as any, parentRegistry, null)) : null;
        this.isAuthoritative = true;

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


        this.stdPath = config.stdPath || null;
        this.includePaths = config.includePaths || [];
        this.loadedDependencies = parentRegistry ? parentRegistry.loadedDependencies : new Map();
        this.shouldMaterializeDependency = false;
        this.transformRules = [];
        this.pendingRules = parentRegistry ? parentRegistry.pendingRules : [];
        this.ruleIdCounter = 0;

        this.mainContext = parentRegistry ? parentRegistry.mainContext : null;
        this.dependencyHelpers = parentRegistry ? parentRegistry.dependencyHelpers : [];
    }

    /**
     * Registers a context-bound rule that will be evaluated whenever new nodes are inserted into the AST.
     * @param {PendingRule<any>} rule - The rule to register.
     */
    registerPendingRule(rule: Omit<PendingRule<any>, 'id'>): number {
        const id = ++this.ruleIdCounter;
        const fullRule = { ...rule, id };
        this.pendingRules.push(fullRule);
        return id;
    }

    /**
     * Registers a new macro in the registry.
     * @param {string} name - Name of the macro.
     * @param {string[]} params - Parameter names.
     * @param {string} body - Macro body (JS or C).
     * @param {string} [language='js'] - Macro implementation language.
     * @param {string} [origin='unknown'] - Origin file or package.
     * @param {number} [startIndex=0] - Start index in the origin file.
     */
    registerMacro(name: string, params: string[], body: string, language: string = 'js', origin: string = 'unknown', startIndex: number = 0): void {
        const macro = { name, params, body, language, origin, startIndex };

        // Eagerly validate JavaScript macros
        if (language === 'js') {
            try {
                this.createMacroFunction(macro);
            } catch (e: any) {
                const lines = body.split('\n');
                const lineCount = lines.length;
                this.diagnostics.reportError(
                    'UPP003',
                    `Syntax error in @${name} macro definition: ${e.message}`,
                    origin,
                    (this.source?.slice(0, startIndex).match(/\n/g) || []).length + 1,
                    startIndex - (this.source?.lastIndexOf('\n', startIndex) ?? 0),
                    this.source || null,
                    false // Don't exit yet, let it be reported
                );
            }
        }

        this.macros.set(name, macro);
        if (this.parentRegistry) {
            this.parentRegistry.registerMacro(name, params, body, language, origin, startIndex);
        }
    }

    /**
     * Retrieves a macro by name, searching parent registries if necessary.
     * @param {string} name - The name of the macro.
     * @returns {Macro | undefined} The macro definition or undefined.
     */
    getMacro(name: string): Macro | undefined {
        if (this.macros.has(name)) return this.macros.get(name);
        if (this.parentRegistry) return this.parentRegistry.getMacro(name);
        return undefined;
    }

    /**
     * Registers a global transformation rule.
     * @param {TransformRule<any> | function(SourceNode<any>, any): any} rule - The rule object or callback.
     */
    registerTransformRule(rule: TransformRule<any> | ((node: SourceNode<any>, helpers: any) => SourceNode<any> | SourceNode<any>[] | SourceTree<any> | string | null | undefined)): void {
        if (typeof rule === 'function') {
            rule = {
                active: true,
                matcher: () => true,
                callback: rule
            };
        }
        this.transformRules.push(rule);
        if (this.parentRegistry) {
            this.parentRegistry.registerTransformRule(rule);
        }
    }

    loadDependency(file: string, originPath: string = 'unknown', parentHelpers: UppHelpersC | null = null): void {
        let targetPath: string;
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
            // Search include paths (from -I flags)
            let found = false;
            for (const inc of this.includePaths) {
                const candidate = path.resolve(inc, file);
                if (fs.existsSync(candidate)) {
                    targetPath = candidate;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const stdDir = this.stdPath || path.resolve(process.cwd(), 'std');
                const stdPath = path.resolve(stdDir, file);
                if (fs.existsSync(stdPath)) {
                    targetPath = stdPath;
                } else {
                    throw new Error(`Dependency not found: ${file} (tried ${targetPath} and ${stdPath})`);
                }
            }
        }

        if (this.config.cache && this.config.cache.get(targetPath) && !isDiscoveryOnly) {
            const cached = this.config.cache.get(targetPath);

            // Only use cache if it's authoritative, or if we don't care about authority (isDiscoveryOnly handled above)
            if (cached && cached.isAuthoritative) {
                // Replay macros
                for (const macro of cached.macros) {
                    this.registerMacro(macro.name, macro.params, macro.body, macro.language, macro.origin, macro.startIndex);
                }
                // Replay transforms
                for (const rule of cached.transformRules) {
                    this.registerTransformRule(rule);
                }
                // Re-emit materialization if needed
                if (cached.shouldMaterialize && this.config.onMaterialize) {
                    let outputPath = targetPath;
                    if (targetPath.endsWith('.hup')) outputPath = targetPath.slice(0, -4) + '.h';
                    else if (targetPath.endsWith('.cup')) outputPath = targetPath.slice(0, -4) + '.c';
                    this.config.onMaterialize(outputPath, cached.output, { isAuthoritative: cached.isAuthoritative });
                }
                return;
            }
        }

        this.loadedDependencies.set(targetPath, isDiscoveryOnly ? 'discovery' : 'full');

        const source = fs.readFileSync(targetPath, 'utf8');
        const depRegistry = new Registry(this.config, this);
        depRegistry.shouldMaterializeDependency = true;

        if (isDiscoveryOnly) {
            depRegistry.isAuthoritative = false;
            depRegistry.source = source;
            depRegistry.prepareSource(source, targetPath);
        } else {
            const output = depRegistry.transform(source, targetPath, parentHelpers);

            // Track dependency helpers for cross-tree type resolution
            if (depRegistry.helpers) {
                this.dependencyHelpers.push(depRegistry.helpers);
            }

            // Store in cache
            if (this.config.cache && !isDiscoveryOnly) {
                const existing = this.config.cache.get(targetPath);
                // Only overwrite if new is authoritative or existing is NOT authoritative
                if (!existing || depRegistry.isAuthoritative || !existing.isAuthoritative) {
                    this.config.cache.set(targetPath, {
                        macros: Array.from(depRegistry.macros.values()),
                        transformRules: depRegistry.transformRules,
                        output: output,
                        shouldMaterialize: depRegistry.shouldMaterializeDependency,
                        isAuthoritative: depRegistry.isAuthoritative
                    });
                }
            }

            if (depRegistry.shouldMaterializeDependency) {
                let outputPath: string | null = null;
                if (targetPath.endsWith('.hup')) outputPath = targetPath.slice(0, -4) + '.h';
                else if (targetPath.endsWith('.cup')) outputPath = targetPath.slice(0, -4) + '.c';

                if (outputPath && this.config.onMaterialize) {
                    this.config.onMaterialize(outputPath, output, { isAuthoritative: depRegistry.isAuthoritative });
                }
            }
        }
    }


    /**
     * Transforms a source string by evaluating macros and applying rules.
     * @param {string} source - The UPP source code.
     * @param {string} [originPath='unknown'] - Path for diagnostic reporting.
     * @param {UppHelpersC | null} [parentHelpers=null] - Parent helper context.
     * @returns {string} The transformed C code.
     */
    transform(source: string, originPath: string = 'unknown', parentHelpers: UppHelpersC | null = null): string {
        this.source = source;
        if (!source) return "";

        // Initialize tree as early as possible so dependencies can see us
        this.tree = new SourceTree<any>(source, this.language as any);
        this.tree.onMutation = () => this.markMutated();
        this.helpers = new UppHelpersC(this.tree.root as any, this, parentHelpers) as any;

        const { cleanSource, invocations: foundInvs } = this.prepareSource(source, originPath);

        // Update tree with clean source if it changed
        if (cleanSource !== source) {
            if (!cleanSource) {
                this.tree = new SourceTree<any>("", this.language as any);
            } else {
                this.tree = new SourceTree<any>(cleanSource, this.language as any);
            }
            if (this.helpers) this.helpers.root = this.tree.root; // Update helpers root
        }
        const sourceTree = this.tree!;

        // Define helpers first, then context
        const helpers = new UppHelpersC(sourceTree.root as any, this, parentHelpers) as any;

        const context: RegistryContext = {
            source: sourceTree.source,
            tree: sourceTree,
            originPath: originPath,
            invocations: foundInvs,
            helpers: helpers,
            transformed: new Set<SourceNode<any>>(),
            transformStack: new Set<SourceNode<any>>(),
            appliedRules: new WeakMap()
        };

        if (!sourceTree) throw new Error("Could not create source tree for transformation.");
        context.helpers = helpers;
        helpers.context = context;
        helpers.root = sourceTree.root;

        const isMain = !this.mainContext;
        if (isMain) {
            this.mainContext = context;
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

        // Final pass for pending rules registered during the walk
        this.evaluatePendingRules([sourceTree.root], helpers, context);

        return sourceTree.source;
    }

    /**
     * Internal helper to mark the current transformation context as mutated.
     */
    public markMutated(): void {
        if (this.mainContext) {
            this.mainContext.mutated = true;
            // Clear semantic caches when tree mutates
            this.mainContext.helpers?.clearSemanticCaches?.();
        }
    }

    /**
     * Recursively evaluates pending rules (fixed-point iteration).
     * This is used for cross-cutting transformations after the initial macro walk.
     * @private
     */
    private evaluatePendingRules(nodes: SourceNode<any>[], helpers: UppHelpersBase<any>, context: RegistryContext): void {
        if (!nodes || nodes.length === 0) return;
        if (this.pendingRules.length === 0) return;

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

                    for (const rule of this.pendingRules) {
                        if (!rule.matcher) continue; // Ensure matcher exists

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
                                            // Process the new subtree for other rules immediately to avoid massive fixed-point iterations
                                            this.transformNode(newNode, helpers, context, true);
                                        }
                                    }
                                }
                                break; // Node replaced, move to next descendant
                            }
                        }
                    }
                }
            }

            if (nextNodes.length > 0) {
                currentNodes = nextNodes;
            } else if (sweepMutated || context.mutated) {
                // If mutations happened elsewhere but no specific new nodes, re-evaluate initial set once
                currentNodes = [...nodes];
                // But only if we haven't already done it many times
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
     * Recursively transforms an AST node by evaluating macros and markers.
     * @param {SourceNode<any>} node - The node to transform.
     * @param {UppHelpersBase<any>} helpers - Helper class instance.
     * @param {RegistryContext} context - Current transformation context.
     * @param {boolean} [force=false] - Whether to bypass the 'transformed' optimization check.
     */
    transformNode(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext, force: boolean = false): void {
        if (!node || node.startIndex === -1) return;

        // PHYSICAL CYCLE CHECK (Absolute Bail)
        if (context.transformStack.has(node)) return;

        // OPTIMIZATION CHECK (Skip if already worked on, unless forced)
        if (!force && context.transformed.has(node)) return;

        context.transformStack.add(node);
        try {
            helpers.contextNode = node;
            helpers.lastConsumedNode = null;

            // 1. Check for Macro Invocation (wrapped in comments by prepareSource)
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

                                // Pre-process string results to wrap nested macros in comments
                                if (typeof finalResult === 'string' && finalResult.includes('@')) {
                                    const prepared = this.prepareSource(finalResult, context.originPath);
                                    finalResult = prepared.cleanSource;
                                }
                            }

                            const newNodes = helpers.replace(node, finalResult);

                            // Evaluate fixed-point rules against the newly injected AST geometry
                            if (newNodes) {
                                const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                this.evaluatePendingRules(list, helpers, context);
                            }

                            // Recursively transform any new nodes in the current context.
                            // If the node was morphed (identity preserved), we must temporarily
                            // remove it from the stack to allow the recursive call to proceed.
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
                                const newNodes = helpers.replace(node, result);
                                if (newNodes) {
                                    const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                    for (const newNode of list) {
                                        const wasInStack = context.transformStack.has(newNode);
                                        if (wasInStack && newNode === node) context.transformStack.delete(newNode);
                                        this.transformNode(newNode, helpers, context, true);
                                        if (wasInStack && newNode === node) context.transformStack.add(newNode);
                                    }
                                }
                            }
                            if (node.startIndex === -1) return;
                        }
                    } catch (e: any) {
                        console.warn(`[upp] transformRule failed on ${node.type}: ${e.message}`);
                    }
                }
            }

            // --- Evaluate Pending Rules (Symbol Tracking) ---
            for (const rule of [...this.pendingRules]) {
                try {
                    if (rule.matcher(node, helpers)) {
                        // Guard: only apply a rule once per node (identity preservation across re-parses)
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
                            // Clear caches after replacement to prevent stale lookups
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

            // 4. Recursive Stable Walk
            for (const child of [...node.children]) {
                this.transformNode(child, helpers, context);
            }
        } finally {
            context.transformStack.delete(node);
            context.transformed.add(node);
        }

        // Post-walk check for newly inserted siblings
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
     * Evaluates a macro invocation and returns the resulting content.
     * @param {Invocation} invocation - The macro invocation details.
     * @param {string} source - The context source.
     * @param {any} helpers - Helper class instance.
     * @param {string} filePath - Current file path.
     * @returns {SourceNode<any> | SourceNode<any>[] | SourceTree<any> | string | null | undefined}
     */
    evaluateMacro(invocation: Invocation, source: string, helpers: UppHelpersBase<any>, filePath: string): MacroResult {
        const macro = this.getMacro(invocation.name);

        const oldInvocation = helpers.invocation;
        const oldContext = helpers.contextNode;
        const oldConsumed = helpers.lastConsumedNode;
        const oldActiveNode = this.activeTransformNode;

        try {
            if (!macro) throw new Error(`Macro @${invocation.name} not found`);

            const invocationNode = invocation.invocationNode!;
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
            const args: (string | SourceNode)[] = [...invocation.args];
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
            this.diagnostics.reportError(0, `Macro @${invocation.name} failed: ${err.message}`, filePath, invocation.line || 1, invocation.col || 1, source);
            return undefined;
        } finally {
            helpers.invocation = oldInvocation;
            helpers.contextNode = oldContext;
            helpers.lastConsumedNode = oldConsumed;
            this.activeTransformNode = oldActiveNode;
        }
    }

    createMacroFunction(macro: Macro): Function {
        const body = macro.body.trim();
        const shouldWrap = macro.language === 'js' &&
            body.length > 0 &&
            !body.startsWith('//') &&
            !body.startsWith('/*') &&
            !body.includes('return');

        const finalBody = shouldWrap && !body.includes(';') && !body.includes('\n') ? `return (${body})` : body;

        try {
            return new Function('upp', 'console', '$', ...macro.params, finalBody);
        } catch (e: any) {
            console.error(`\n[upp] Syntax error in definition of @${macro.name}:`);
            console.error(e.message);
            throw e;
        }
    }

    /**
     * Prepares source code by identifying macro invocations and masking them.
     * @param {string} source - The raw source code.
     * @param {string} originPath - Path for diagnostics.
     * @returns {{ cleanSource: string, invocations: Invocation[] }} Masked source and invocations.
     */
    prepareSource(source: string, originPath: string): { cleanSource: string; invocations: Invocation[] } {
        const definerRegex = /^\s*@define\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
        let cleanSource = source;
        const tree = this.parser.parse((index: number) => {
            if (index >= source.length) return null;
            return source.slice(index, index + 4096);
        });

        const defines: Array<{ index: number; length: number; original: string }> = [];
        let match;
        while ((match = definerRegex.exec(source)) !== null) {
            const node = tree.rootNode.descendantForIndex(match.index);
            let shouldSkip = false;
            let curr: SyntaxNode | null = node;
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
            defines.push({ index: match.index, length: fullMatchLength, original: source.slice(match.index, match.index + fullMatchLength) });
        }

        for (let i = defines.length - 1; i >= 0; i--) {
            const def = defines[i];
            let replaced = "";
            if (this.config.comments) {
                const commentContent = def.original.replace(/^(\s*)@/, '$1');
                replaced = `/* ${commentContent} */`;
            }
            cleanSource = cleanSource.slice(0, def.index) + replaced + cleanSource.slice(def.index + def.length);
        }

        const cleanTree = this.parser.parse((index: number) => {
            if (index >= cleanSource.length) return null;
            return cleanSource.slice(index, index + 4096);
        });
        const invocations = this.findInvocations(cleanSource, cleanTree);
        for (let i = invocations.length - 1; i >= 0; i--) {
            const inv = invocations[i];
            const original = cleanSource.slice(inv.startIndex, inv.endIndex);

            if (inv.name === 'include') {
                const file = inv.args[0];
                if (file) {
                    let filename = file;
                    if ((filename.startsWith('"') && filename.endsWith('"')) || (filename.startsWith("'") && filename.endsWith("'"))) {
                        filename = filename.slice(1, -1);
                    }
                    this.loadDependency(filename, originPath);
                }
            }
            cleanSource = cleanSource.slice(0, inv.startIndex) + `/*${original}*/` + cleanSource.slice(inv.endIndex);
        }

        return { cleanSource, invocations };
    }

    extractBody(source: string, startOffset: number): string {
        let depth = 1;
        let i = startOffset;
        let inString: string | null = null;
        let inComment: string | null = null; // 'line' or 'block'
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

    findInvocations(source: string, tree: Tree | null = null): Invocation[] {
        const invs: Invocation[] = [];
        const regex = /(?<![\/*])@(\w+)(\s*\(([^)]*)\))?/g;
        let match;
        const currentTree = tree || this.parser.parse((index: number) => {
            if (index >= source.length) return null;
            return source.slice(index, index + 4096);
        });

        while ((match = regex.exec(source)) !== null) {


            const node = currentTree.rootNode.descendantForIndex(match.index);
            let shouldSkip = false;
            let curr: SyntaxNode | null = node;
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

export { Registry };
