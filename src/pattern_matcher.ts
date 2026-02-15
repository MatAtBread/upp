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
            if (this.structuralMatch(targetNode, patternRoot, captures, constraints)) {
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
            if (this.structuralMatch(targetNode, patternRoot, captures, constraints)) {
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

        if (patternRoot.type === 'translation_unit' && patternRoot.childCount > 0) {
            for (let i = 0; i < patternRoot.childCount; i++) {
                const child = patternRoot.child(i);
                if (child && child.type !== 'comment') {
                    patternRoot = child;
                    break;
                }
            }
        }

        // Drill down from expression_statement if the pattern string doesn't end with a semicolon.
        // This allows expression patterns (like assignments) to match expression nodes anywhere,
        // rather than being locked to statement-level matching.
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
        if (this.structuralMatch(node, patternNode, captures, constraints)) {
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
        if (this.structuralMatch(node, patternNode, captures, constraints)) {
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
    private structuralMatch(target: PatternMatchableNode, pattern: SyntaxNode, captures: CaptureResult, constraints: ConstraintMap): boolean {
        // console.log(`structuralMatch target="${target.type}" pattern="${pattern.type}" pText="${pattern.text}" tText="${target.text}"`);
        const match = pattern.text.trim().match(/^\$([a-zA-Z0-9_$]+);?$/);
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
            return false;
        }

        // 3. Leaf check (text match for keywords/literals)
        if (target.childCount === 0 && pattern.childCount === 0) {
            return target.text === pattern.text;
        }

        // 4. Children check
        const targetChildren = this.getChildren(target);
        const patternChildren = this.getChildren(pattern);

        let ti = 0;
        for (let pi = 0; pi < patternChildren.length; pi++) {
            const pChild = patternChildren[pi];
            const wildcardResult = this.getWildcard(pChild);

            if (wildcardResult && wildcardResult.isUntil) {
                const { name } = wildcardResult;
                if (pi === patternChildren.length - 1) {
                    // Last child, consume all remaining
                    captures[name] = targetChildren.slice(ti);
                    ti = targetChildren.length;
                } else {
                    // Match until next node in pattern
                    const terminator = patternChildren[pi + 1];
                    const startTi = ti;
                    let found = false;
                    while (ti < targetChildren.length) {
                        const tmpCaptures = { ...captures };
                        if (this.structuralMatch(targetChildren[ti], terminator, tmpCaptures, constraints)) {
                            found = true;
                            break;
                        }
                        ti++;
                    }
                    if (!found) return false;
                    captures[name] = targetChildren.slice(startTi, ti);
                }
            } else {
                if (ti >= targetChildren.length) return false;
                if (!this.structuralMatch(targetChildren[ti], pChild, captures, constraints)) {
                    return false;
                }
                ti++;
            }
        }

        return ti === targetChildren.length;
    }

    private getWildcard(node: SyntaxNode): { name: string; isUntil: boolean } | null {
        // syntax: $name or $name;
        const match = node.text.trim().match(/^\$([a-zA-Z0-9_$]+);?$/);
        if (!match) return null;
        let name = match[1];
        let isUntil = false;
        if (name.endsWith('__until')) {
            name = name.slice(0, -7);
            isUntil = true;
        }
        if (name.startsWith('opt$')) {
            name = name.slice(4);
        }
        return { name, isUntil };
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
            return '$' + name;
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
        const rawTypes = parts.slice(1).filter(t => t !== 'until');

        if (name.startsWith('opt$')) {
            name = name.slice(4);
        }

        // Re-append __until if it was present
        if (rawId.includes('__until')) {
            name += '__until';
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
