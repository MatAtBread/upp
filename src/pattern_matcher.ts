import type { Tree, SyntaxNode } from 'tree-sitter';
import type { PatternMatchableNode } from './types.ts';

export interface ConstraintSpec {
    type: string;
    not: boolean;
}

export type ConstraintMap = Map<string, ConstraintSpec[]>;

export interface CaptureResult {
    node?: PatternMatchableNode;
    [key: string]: any;
}

/**
 * Handles structural pattern matching for code fragments.
 */
export class PatternMatcher {
    private parseFn: (code: string) => Tree;
    private cache: Map<string, { patternRoot: SyntaxNode; constraints: ConstraintMap }>;
    private language: any;

    /**
     * @param {function(string): Tree} parseFn - Function to parse a code fragment.
     * @param {any} language - The language object.
     */
    constructor(parseFn: (code: string) => Tree, language: any) {
        this.parseFn = parseFn;
        this.language = language;
        this.cache = new Map();
    }

    /**
     * Matches a target node against a pattern string.
     * @param {PatternMatchableNode} targetNode - The node to match against.
     * @param {string} patternStr - The code pattern (e.g., "int $x = 0;").
     * @param {boolean} [deep=false] - Whether to search the subtree.
     * @returns {CaptureResult | null} Captures object or null.
     */
    match(targetNode: PatternMatchableNode, patternStr: string, deep: boolean = false): CaptureResult | null {
        const { patternRoot, constraints } = this.prepare(patternStr);
        if (deep) {
            return this.findMatch(targetNode, patternRoot, constraints);
        } else {
            const captures: CaptureResult = {};
            if (this.structuralMatch(targetNode, patternRoot, captures, constraints, new Set())) {
                captures.node = targetNode;
                return captures;
            }
            return null;
        }
    }

    /**
     * Matches all occurrences of a pattern.
     * @returns {Array<CaptureResult>} Array of capture objects.
     */
    matchAll(targetNode: PatternMatchableNode, patternStr: string, deep: boolean = false): CaptureResult[] {
        const { patternRoot, constraints } = this.prepare(patternStr);
        if (deep) {
            return this.findAllMatches(targetNode, patternRoot, constraints);
        } else {
            const captures: CaptureResult = {};
            if (this.structuralMatch(targetNode, patternRoot, captures, constraints, new Set())) {
                captures.node = targetNode;
                return [captures];
            }
            return [];
        }
    }

    /**
     * Prepares a pattern string for matching.
     * @param {string} patternStr - The pattern string to prepare.
     * @returns {{ patternRoot: SyntaxNode; constraints: ConstraintMap }} Object containing patternRoot and constraints.
     */
    prepare(patternStr: string): { patternRoot: SyntaxNode; constraints: ConstraintMap } {
        // Cache disabled to avoid NodeClass/context issues with Tree objects
        const result = this.preprocessPattern(patternStr);
        const { cleanPattern, constraints } = result;
        const patternTree = this.parseFn(cleanPattern);

        let patternRoot = patternTree.rootNode;

        // If the pattern is a fragment (like an expression or list of statements), 
        // it may parse as an ERROR at top level. Try wrapping it in a function body.
        const isErrorNode = (n: SyntaxNode) => {
            if (n.type === 'ERROR') return true;
            if (n.type === 'translation_unit') {
                for (let i = 0; i < n.childCount; i++) {
                    if (n.child(i)?.type === 'ERROR') return true;
                }
            }
            return false;
        };

        if (isErrorNode(patternRoot)) {
            const prefix = "void __upp_frag() { ";
            const wrappedCode = `${prefix}${cleanPattern}\n}`;
            const wrappedTree = this.parseFn(wrappedCode);
            const wrappedRoot = wrappedTree.rootNode;

            // Navigate to the compound_statement of the function definition
            let body: SyntaxNode | null = null;
            const findBody = (n: SyntaxNode) => {
                if (n.type === 'compound_statement') { body = n; return; }
                for (let i = 0; i < n.childCount; i++) {
                    const c = n.child(i);
                    if (c) findBody(c);
                    if (body) return;
                }
            };
            findBody(wrappedRoot);

            if (body) {
                const kids: SyntaxNode[] = [];
                for (let i = 0; i < (body as SyntaxNode).childCount; i++) {
                    const c = (body as SyntaxNode).child(i);
                    if (c && c.type !== '{' && c.type !== '}' && c.type !== 'comment') {
                        kids.push(c);
                    }
                }
                if (kids.length === 1) {
                    patternRoot = kids[0];
                } else if (kids.length > 1) {
                    // It's a list of statements/nodes
                    patternRoot = body as SyntaxNode;
                }
            }
        }

        if (patternRoot.type === 'translation_unit' && patternRoot.childCount > 0) {
            for (let i = 0; i < patternRoot.childCount; i++) {
                const child = patternRoot.child(i);
                if (child && child.type !== 'comment') {
                    patternRoot = child;
                    break;
                }
            }
        }

        // Drill down from expression_statement to the underlying expression
        // unless the pattern string explicitly ends with a semicolon.
        if (patternRoot.type === 'expression_statement') {
            const significantChildren: SyntaxNode[] = [];
            for (let i = 0; i < patternRoot.childCount; i++) {
                const child = patternRoot.child(i);
                if (child && child.type !== 'comment' && child.type !== ';') {
                    significantChildren.push(child);
                }
            }
            if (significantChildren.length === 1 && !patternStr.trim().endsWith(';')) {
                patternRoot = significantChildren[0];
            }
        }

        return { patternRoot, constraints };
    }

    /**
     * Recursively searches for a match in the subtree.
     */
    private findMatch(node: PatternMatchableNode, patternNode: SyntaxNode, constraints: ConstraintMap): CaptureResult | null {
        const captures: CaptureResult = {};
        if (this.structuralMatch(node, patternNode, captures, constraints, new Set())) {
            captures.node = node;
            return captures;
        }
        for (let i = 0; i < node.childCount; i++) {
            const childResult = node.child(i);
            if (childResult) {
                const result = this.findMatch(childResult, patternNode, constraints);
                if (result) return result;
            }
        }
        return null;
    }

    private findAllMatches(node: PatternMatchableNode, patternNode: SyntaxNode, constraints: ConstraintMap, results: CaptureResult[] = []): CaptureResult[] {
        const captures: CaptureResult = {};
        // Important: check if node matches
        if (this.structuralMatch(node, patternNode, captures, constraints, new Set())) {
            captures.node = node;
            results.push(captures);
        }
        // Continue searching descendants
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                try {
                    this.findAllMatches(child, patternNode, constraints, results);
                } catch (e: any) {
                    // Diagnose specific node failure
                    console.error(`PatternMatcher crash on node type '${node.type}': ${e.message}`);
                    // console.error(e.stack);
                }
            }
        }
        return results;
    }

    /**
     * Compares two nodes structurally with wildcards.
     * @param {PatternMatchableNode} target
     * @param {SyntaxNode} pattern
     * @param {CaptureResult} captures
     * @param {ConstraintMap} constraints
     * @returns {boolean}
     */
    private structuralMatch(target: PatternMatchableNode, pattern: SyntaxNode, captures: CaptureResult, constraints: ConstraintMap, visited: Set<PatternMatchableNode> = new Set()): boolean {
        if (!target || visited.has(target)) return false;

        // 0. Explicitly block matching on ERROR nodes or macro-like constructs
        if (target.type === 'ERROR' || pattern.type === 'ERROR') return false;
        if (target.type === 'comment' && target.text.trim().startsWith('// @')) return false;

        visited.add(target);
        // console.log(`structuralMatch target="${target.type}" pattern="${pattern.type}" pText="${pattern.text}" tText="${target.text}"`);

        // 1. Wildcard check
        const match = pattern.text.trim().match(/^UPP_WILDCARD_([a-zA-Z0-9_$]+);?$/);
        if (match) {
            let name = match[1];
            if (name.startsWith('opt$')) {
                name = name.slice(4);
            }

            // Check constraints
            if (constraints.has(name)) {
                // allowedTypes is Array<{type: string, not: boolean}>
                const constraintSpecs = constraints.get(name)!;

                // 1. Negative checks (if any match, fail immediately)
                const isForbidden = constraintSpecs.some(spec => spec.not && spec.type === target.type);
                if (isForbidden) return false;

                // 2. Positive checks (must match at least one, IF positive constraints exist)
                const positiveSpecs = constraintSpecs.filter(spec => !spec.not);
                if (positiveSpecs.length > 0) {
                    const isAllowed = positiveSpecs.some(spec => spec.type === target.type);
                    if (!isAllowed) return false;
                }
            }

            // Bind capture
            if (captures[name]) {
                return captures[name].text === target.text;
            } else {
                captures[name] = target;
                return true;
            }
        }

        // 2. Strict type check
        if (target.type !== pattern.type) {
            // Allow declaration to match parameter_declaration and vice-versa
            const isDeclMatch = (target.type === 'declaration' || target.type === 'parameter_declaration') &&
                (pattern.type === 'declaration' || pattern.type === 'parameter_declaration');
            if (!isDeclMatch) return false;
        }

        // 3. Leaf check (text match for keywords/literals)
        if (target.childCount === 0 && pattern.childCount === 0) {
            return target.text === pattern.text;
        }

        // 4. Children check
        const targetChildren = this.getChildren(target);
        const patternChildren = this.getChildren(pattern);

        return this.matchChildren(targetChildren, patternChildren, 0, 0, captures, constraints, visited);
    }

    private matchChildren(targetChildren: PatternMatchableNode[] | SyntaxNode[], patternChildren: SyntaxNode[], ti: number, pi: number, captures: CaptureResult, constraints: ConstraintMap, visited: Set<PatternMatchableNode>): boolean {
        if (pi === patternChildren.length) {
            return ti === targetChildren.length;
        }

        const pChild = patternChildren[pi];
        const wildcardResult = this.getWildcard(pChild);

        if (wildcardResult && (wildcardResult.isUntil || wildcardResult.isPlus)) {
            const { name, isPlus } = wildcardResult;
            // Try all possible split points (backtracking)
            // If isPlus is true, we need at least one element (split starting from ti + 1)
            for (let split = isPlus ? ti + 1 : ti; split <= targetChildren.length; split++) {
                const subCaptures = { ...captures };
                subCaptures[name] = targetChildren.slice(ti, split);
                if (this.matchChildren(targetChildren, patternChildren, split, pi + 1, subCaptures, constraints, visited)) {
                    Object.assign(captures, subCaptures);
                    return true;
                }
            }
            return false;
        } else {
            if (ti >= targetChildren.length) return false;
            const subCaptures = { ...captures };
            if (this.structuralMatch(targetChildren[ti] as any, pChild, subCaptures, constraints, visited)) {
                if (this.matchChildren(targetChildren, patternChildren, ti + 1, pi + 1, subCaptures, constraints, visited)) {
                    Object.assign(captures, subCaptures);
                    return true;
                }
            }
            return false;
        }
    }

    private getWildcard(node: SyntaxNode): { name: string; isUntil: boolean; isPlus: boolean } | null {
        // syntax: UPP_WILDCARD_name or UPP_WILDCARD_name;
        const text = node.text.trim();
        const match = text.match(/^UPP_WILDCARD_([a-zA-Z0-9_$]+);?$/);
        if (!match) return null;
        let name = match[1];
        let isUntil = false;
        let isPlus = false;
        if (name.endsWith('__until')) {
            name = name.slice(0, -7);
            isUntil = true;
        } else if (name.endsWith('__plus')) {
            name = name.slice(0, -6);
            isPlus = true;
        }
        if (name.startsWith('opt$')) {
            name = name.slice(4);
        }
        return { name, isUntil, isPlus };
    }

    private getChildren<T extends PatternMatchableNode | SyntaxNode>(node: T): T[] {
        const kids: T[] = [];
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child as any).type !== 'comment') {
                const raw = child as any;
                if (raw.isMissing === true) continue;
                if (typeof raw.startIndex === 'number' && raw.startIndex === raw.endIndex) continue;
                kids.push(child as T);
            }
        }
        return kids;
    }

    /**
     * Pre-processes pattern string to extract constraints.
     * @param {string} patternStr
     * @returns {{cleanPattern: string, constraints: ConstraintMap}}
     */
    private preprocessPattern(patternStr: string): { cleanPattern: string; constraints: ConstraintMap } {
        const constraints: ConstraintMap = new Map();
        // Match any potential wildcard starting with $
        const cleanPattern = patternStr.replace(/\$([a-zA-Z0-9_$]+)/g, (_match, rawId) => {
            const { name, types } = this.parseWildcard(rawId);
            if (types && types.length > 0) {
                constraints.set(name, types);
            }
            return 'UPP_WILDCARD_' + name;
        });
        return { cleanPattern, constraints };
    }

    /**
     * Parses a raw wildcard identifier into name and types.
     * @param {string} rawId - The identifier text after $.
     * @returns {{name: string; types: ConstraintSpec[]}}
     */
    private parseWildcard(rawId: string): { name: string; types: ConstraintSpec[] } {
        // syntax: name__type1__type2 or opt$name__type1 or name__until
        const parts = rawId.split('__');
        let name = parts[0];
        const rawTypes = parts.slice(1).filter(t => t !== 'until' && t !== 'plus');

        if (name.startsWith('opt$')) {
            name = name.slice(4);
        }

        // Re-append modifiers if they were present
        if (rawId.includes('__until')) {
            name += '__until';
        }
        if (rawId.includes('__plus')) {
            name += '__plus';
        }

        const types = rawTypes.map(t => {
            if (t.startsWith('NOT_')) {
                return { type: t.slice(4), not: true };
            }
            return { type: t, not: false };
        });

        return { name, types };
    }
}
