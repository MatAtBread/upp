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

export const RECURSION_LIMITER_ENABLED = false;

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
    cache?: DependencyCache;
    diagnostics?: DiagnosticsManager;
    suppress?: string[];
    comments?: boolean;
}

export interface Marker<T extends string = string> {
    callback: (node: SourceNode<T>, helpers: UppHelpersBase<any>) => MacroResult;
    data?: unknown;
}

export interface RegistryContext {
    source: string;
    tree: SourceTree<any>;
    originPath: string;
    invocations: Invocation[];
    helpers: UppHelpersBase<any> | null;
    transformed: Set<string>;
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
    public parentTree: SourceTree<any> | null;
    public materializedFiles: Set<string>;
    public isAuthoritative: boolean;
    public macros: Map<string, Macro>;
    public parser: Parser;
    public idCounter: number;
    public stdPath: string | null;
    public loadedDependencies: Map<string, string>;
    public shouldMaterializeDependency: boolean;
    public transformRules: TransformRule<any>[];
    public pendingRules: PendingRule<any>[];
    public ruleIdCounter: number;
    public isExecutingDeferred: boolean;
    public onMaterialize: ((outputPath: string, content: string, options: { isAuthoritative: boolean }) => void) | null;
    public mainContext: RegistryContext | null;
    public UppHelpersC: typeof UppHelpersC;
    public source?: string;
    public tree?: SourceTree<any>;
    public deferredMarkers?: Marker<any>[];
    public activeTransformNode?: SourceNode<any> | null;
    public originPath?: string;

    constructor(config: RegistryConfig = {}, parentRegistry: Registry | null = null) {
        this.config = config;
        this.parentRegistry = parentRegistry;
        this.onMaterialize = config.onMaterialize || (parentRegistry ? parentRegistry.onMaterialize : null);
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
        this.parentHelpers = parentRegistry ? (parentRegistry.helpers || new UppHelpersBase(null, parentRegistry, null)) : null;
        this.parentTree = parentRegistry ? parentRegistry.tree! : null;

        this.materializedFiles = new Set();
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

        this.idCounter = 0;
        this.stdPath = config.stdPath || null;
        this.loadedDependencies = parentRegistry ? parentRegistry.loadedDependencies : new Map();
        this.shouldMaterializeDependency = false;
        this.transformRules = [];
        this.pendingRules = parentRegistry ? parentRegistry.pendingRules : [];
        this.ruleIdCounter = 0;
        this.isExecutingDeferred = false;
        this.onMaterialize = config.onMaterialize || null;
        this.mainContext = parentRegistry ? parentRegistry.mainContext : null;
        this.UppHelpersC = UppHelpersC; // Ensure this is available
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
            const stdDir = this.stdPath || path.resolve(process.cwd(), 'std');
            const stdPath = path.resolve(stdDir, file);
            if (fs.existsSync(stdPath)) {
                targetPath = stdPath;
            } else {
                throw new Error(`Dependency not found: ${file} (tried ${targetPath} and ${stdPath})`);
            }
        }

        if (this.config.cache && this.config.cache.has(targetPath) && !isDiscoveryOnly) {
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

    generateRuleId(): string {
        return `rule_${++this.ruleIdCounter}`;
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
        this.helpers = new (this.UppHelpersC as any)(this.tree.root, this, parentHelpers);

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
        const helpers = new this.UppHelpersC(sourceTree.root as any, this, parentHelpers) as any;

        const context: RegistryContext = {
            source: cleanSource, // This will be stale, should use sourceTree.source
            tree: sourceTree,
            originPath: originPath,
            invocations: foundInvs,
            helpers: helpers, // Now helpers is defined
            transformed: new Set<string>(), // Add transformed set
            appliedRules: new WeakMap()
        };

        if (!sourceTree) throw new Error("Could not create source tree for transformation.");
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

        this.executeDeferredMarkers(helpers);

        return sourceTree.source;
    }

    public markMutated(): void {
        if (this.mainContext) {
            this.mainContext.mutated = true;
        }
    }

    /**
     * Internal fixed-point evaluator. Given a set of newly inserted nodes,
     * it sweeps them (and their descendants) against all registered `pendingRules`.
     * If a rule triggers and alters the AST further, the process recurses on the newest nodes
     * until the tree ceases to mutate relative to these rules.
     */
    private evaluatePendingRules(nodes: SourceNode<any>[], helpers: UppHelpersBase<any>, context: RegistryContext): void {
        if (!nodes || nodes.length === 0 || this.pendingRules.length === 0) return;

        let iterations = 0;
        const MAX_ITERATIONS = 50; // Guard against infinite replacement loops
        let currentNodes = [...nodes];

        while (currentNodes.length > 0 && iterations < MAX_ITERATIONS) {
            iterations++;
            context.mutated = false;
            let currentIterationMutated = false;
            const nextNodes: SourceNode<any>[] = [];

            for (const node of currentNodes) {
                if (node.startIndex === -1) continue; // Skip invalidated

                // We must check if `node` falls underneath ANY registered rule's context
                for (const rule of this.pendingRules) {
                    try {
                        helpers.walk(node, (descendant: SourceNode<any>) => {
                            if (descendant.startIndex === -1) return;

                            if (rule.matcher(descendant, helpers)) {
                                // Guard: only apply a rule once per node (identity preservation across re-parses)
                                let applied = descendant.data._appliedRules as Set<number>;
                                if (!applied) {
                                    applied = new Set();
                                    descendant.data._appliedRules = applied;
                                }
                                if (applied.has(rule.id)) return;
                                applied.add(rule.id);

                                helpers.contextNode = descendant;
                                helpers.lastConsumedNode = null;
                                const result = rule.callback(descendant, helpers);
                                if (result !== undefined) {
                                    const replacementNodes = helpers.replace(descendant, result);
                                    currentIterationMutated = true;
                                    if (replacementNodes) {
                                        const list = Array.isArray(replacementNodes) ? replacementNodes : [replacementNodes];
                                        for (const newNode of list) {
                                            if (newNode instanceof SourceNode) {
                                                helpers.walk(newNode, (child) => {
                                                    let app = child.data._appliedRules as Set<number>;
                                                    if (!app) { app = new Set(); child.data._appliedRules = app; }
                                                    app.add(rule.id);
                                                });
                                                nextNodes.push(newNode);
                                                this.transformNode(newNode, helpers, context);
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    } catch (e) {
                        console.error(`PendingRule callback failed on ${node.type}:`, e);
                    }
                }
            }

            if (!currentIterationMutated && !context.mutated) break;
            currentNodes = nextNodes;

            // If something else mutated (like insertBefore) but we don't have SPECIFIC new nodes to walk,
            // we have to re-evaluate the whole initial set to catch side-effects.
            if (currentNodes.length === 0 && context.mutated) {
                currentNodes = nodes;
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
     */
    transformNode(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext): void {
        if (!node) return;

        // Skip invalidated nodes
        if (node.startIndex === -1) return;

        // Skip already transformed nodes in this pass
        if (context.transformed.has(String(node.id))) return;
        context.transformed.add(String(node.id));

        helpers.contextNode = node;
        helpers.lastConsumedNode = null;

        // 1. Check for attached markers/callbacks (Deferred transformations)
        const markers = [...node.markers];
        node.markers = []; // Clear so we don't re-run
        for (const marker of markers) {
            try {
                const result = marker.callback(node, helpers);
                if (result !== undefined) {
                    const newNodes = helpers.replace(node, result);
                    if (newNodes) {
                        const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                        this.evaluatePendingRules(list, helpers, context);
                        for (const newNode of list) {
                            this.transformNode(newNode, helpers, context);
                        }
                    }
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

                        // Recursively transform any new nodes in the current context
                        if (Array.isArray(newNodes)) {
                            for (const newNode of newNodes) {
                                if (newNode instanceof SourceNode) {
                                    this.transformNode(newNode, helpers, context);
                                }
                            }
                        } else if (newNodes instanceof SourceNode) {
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
                            const newNodes = helpers.replace(node, result);
                            if (newNodes) {
                                const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                for (const newNode of list) {
                                    this.transformNode(newNode, helpers, context);
                                }
                            }
                        }
                        if (node.startIndex === -1) return;
                    }
                } catch (e) {
                    // rule failed
                }
            }
        }

        // --- NEW: Evaluate Pending Rules (Symbol Tracking) ---
        for (const rule of [...this.pendingRules]) {
            try {
                if (rule.matcher(node, helpers)) {
                    // Guard: only apply a rule once per node (identity preservation across re-parses)
                    let applied = node.data._appliedRules as Set<number>;
                    if (!applied) {
                        applied = new Set();
                        node.data._appliedRules = applied;
                    }
                    if (applied.has(rule.id)) continue;
                    applied.add(rule.id);

                    const result = rule.callback(node, helpers);
                    if (result !== undefined) {
                        const newNodes = helpers.replace(node, result);
                        if (newNodes) {
                            const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                            for (const newNode of list) {
                                if (newNode instanceof SourceNode) {
                                    helpers.walk(newNode, (child) => {
                                        let app = child.data._appliedRules as Set<number>;
                                        if (!app) { app = new Set(); child.data._appliedRules = app; }
                                        app.add(rule.id);
                                    });
                                }
                                // IMPORTANT: transformNode will handle recursion and macro expansion.
                                // We don't call evaluatePendingRules here to avoid infinite recursion loops.
                                this.transformNode(newNode, helpers, context);
                            }
                        }
                    }
                    if (node.startIndex === -1) return;
                }
            } catch (e) {
                // symbol rule check failed
            }
        }

        // 4. Recursive Stable Walk
        // NOTE: We snapshot children because transformations might add/remove nodes
        const originalChildren = [...node.children];
        for (const child of originalChildren) {
            this.transformNode(child, helpers, context);
        }

        // Post-walk check for newly inserted siblings
        let hasNewSiblings = true;
        while (hasNewSiblings) {
            hasNewSiblings = false;
            for (const child of node.children) {
                if (child.startIndex !== -1 && !context.transformed.has(String(child.id))) {
                    this.transformNode(child, helpers, context);
                    hasNewSiblings = true;
                    break;
                }
            }
        }
    }


    executeDeferredMarkers(helpers: UppHelpersBase<any>): void {
        if (this.isExecutingDeferred) return;
        this.isExecutingDeferred = true;

        try {
            let iterations = 0;
            const MAX_ITERATIONS = 100;

            while (iterations < MAX_ITERATIONS) {
                // Find all nodes that have pending markers
                const nodesWithMarkers = this.tree!.root.find(n => n.markers.length > 0 && n.startIndex !== -1);

                if (nodesWithMarkers.length === 0) break;

                iterations++;

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
                                const newNodes = helpers.replace(node, result);
                                if (newNodes) {
                                    const list = Array.isArray(newNodes) ? newNodes : [newNodes];
                                    const context = (helpers as any).context || this.mainContext;
                                    this.evaluatePendingRules(list, helpers, context);
                                    for (const newNode of list) {
                                        this.transformNode(newNode, helpers, context);
                                    }
                                }
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
            // console.error(`Macro @${invocation.name} failed:`, err);
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
        // Avoid wrapping empty or comment-only macros in 'return ()' which is invalid syntax
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
            console.error("\nMacro body:");
            console.error("--------------------------------------------------------------------------------");
            console.error(finalBody);
            console.error("--------------------------------------------------------------------------------\n");
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

        // Apply defines in reverse to keep indices stable
        for (let i = defines.length - 1; i >= 0; i--) {
            const def = defines[i];
            let replaced = "";
            if (this.config.comments) {
                const commentContent = def.original.replace(/^(\s*)@/, '$1');
                replaced = `/* ${commentContent} */`;
            }
            cleanSource = cleanSource.slice(0, def.index) + replaced + cleanSource.slice(def.index + def.length);
        }

        // Must re-parse after cleaning defines to find invocations correctly
        const cleanTree = this.parser.parse((index: number) => {
            if (index >= cleanSource.length) return null;
            return cleanSource.slice(index, index + 4096);
        });
        const invocations = this.findInvocations(cleanSource, cleanTree);
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
            if (this.isInsideInvocation(match.index, match.index + match[0].length)) continue;

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

    isInsideInvocation(_start: number, _end: number): boolean {
        return false;
    }
}

export { Registry };
