import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import fs from 'fs';
import path from 'path';
import { UppHelpersC } from './upp_helpers_c.ts';
import { UppHelpersBase } from './upp_helpers_base.ts';
import { DiagnosticsManager } from './diagnostics.ts';
import { SourceTree, SourceNode } from './source_tree.ts';
import { Transformer } from './transformer.ts';
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
    pendingRules: PendingRule<any>[];
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
                // Replay pending rules from dependency
                for (const rule of cached.pendingRules) {
                    this.registerPendingRule(rule);
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
                        pendingRules: depRegistry.pendingRules,
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
     * Compiles a macro body into a callable function.
     * Also called by Transformer for macro invocations.
     */
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
     * Transforms preprocessed source, expanding macros and applying rules.
     * Delegates the actual pipeline to the Transformer class.
     */
    transform(source: string, originPath: string = 'unknown', parentHelpers: UppHelpersC | null = null): string {
        return new Transformer(this).run(source, originPath, parentHelpers);
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
     * Prepares source code by identifying macro invocations and masking them.
     * @param {string} source - The raw source code.
     * @param {string} originPath - Path for diagnostics.
     * @returns {{ cleanSource: string, invocations: Invocation[] }} Masked source and invocations.
     */
    /**
     * Prepares source for transformation:
     * Phase 1 (pure): parse @define blocks, strip them from source, find macro invocations.
     * Phase 2 (side effects): register macros, load @include dependencies.
     */
    prepareSource(source: string, originPath: string): { cleanSource: string; invocations: Invocation[] } {
        // --- Phase 1: Pure source analysis ---
        const definerRegex = /^\s*@define\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
        let cleanSource = source;
        const tree = this.parser.parse((index: number) => {
            if (index >= source.length) return null;
            return source.slice(index, index + 4096);
        });

        const defines: Array<{ index: number; length: number; original: string; name: string; params: string[]; body: string }> = [];
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

            const fullMatchLength = match[0].length + body.length + 1;
            defines.push({ index: match.index, length: fullMatchLength, original: source.slice(match.index, match.index + fullMatchLength), name, params, body });
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
            cleanSource = cleanSource.slice(0, inv.startIndex) + `/*${original}*/` + cleanSource.slice(inv.endIndex);
        }

        // --- Phase 2: Side effects — register macros and load dependencies ---
        for (const def of defines) {
            this.registerMacro(def.name, def.params, def.body, 'js', originPath, def.index);
        }
        for (const inv of invocations) {
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
