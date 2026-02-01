
/**
 * Handles structural pattern matching for code fragments.
 */
export class PatternMatcher {
    /**
     * @param {function(string): import('tree-sitter').Tree} parseFn - Function to parse a code fragment.
     */
    constructor(parseFn) {
        this.parseFn = parseFn;
    }

    /**
     * Matches a target node against a pattern string.
     * @param {import('tree-sitter').SyntaxNode} targetNode - The node to match against.
     * @param {string} patternStr - The code pattern (e.g., "int $x = 0;").
     * @param {boolean} [deep=false] - Whether to search the subtree.
     * @returns {Object|null} Captures object or null.
     */
    match(targetNode, patternStr, deep = false) {
        const { cleanPattern, constraints } = this.preprocessPattern(patternStr);
        const patternTree = this.parseFn(cleanPattern);
        let patternRoot = patternTree.rootNode;

        // Tree-sitter usually wraps fragments in translation_unit.
        // We want the first significant child.
        if (patternRoot.type === 'translation_unit' && patternRoot.childCount > 0) {
            // Find first non-comment child? Or use the whole unit?
            // Usually we want to match a statement or expression.
            // If pattern is "int $x;", target is declaration.
            // translation_unit -> declaration.
            // So we start matching at the first child of translation_unit?
            // Or we try to match translation_unit against target? (Unlikely)
            // Let's find the first "real" node.
            for (let i = 0; i < patternRoot.childCount; i++) {
                 const child = patternRoot.child(i);
                 if (child.type !== 'comment') {
                     patternRoot = child;
                     break;
                 }
            }
        }

        if (deep) {
            return this.findMatch(targetNode, patternRoot, constraints);
        } else {
            const captures = {};
            if (this.structuralMatch(targetNode, patternRoot, captures, constraints)) {
                 captures.node = targetNode; // Includes the matched node itself? User said "return object with sourceNode"
                 return captures;
            }
            return null;
        }
    }

    /**
     * Recursively searches for a match in the subtree.
     */
    findMatch(node, patternNode, constraints) {
        const captures = {};
        if (this.structuralMatch(node, patternNode, captures, constraints)) {
            captures.node = node;
            return captures;
        }
        for (let i = 0; i < node.childCount; i++) {
            const result = this.findMatch(node.child(i), patternNode, constraints);
            if (result) return result;
        }
        return null;
    }

    /**
     * Compares two nodes structurally with wildcards.
     * @param {import('tree-sitter').SyntaxNode} target
     * @param {import('tree-sitter').SyntaxNode} pattern
     * @param {Object} captures
     * @param {Map<string, Array<{type: string, not: boolean}>>} constraints
     * @returns {boolean}
     */
    structuralMatch(target, pattern, captures, constraints) {
        // 1. Check for wildcard in pattern
        // Pattern logic: if pattern is an identifier starting with $, it captures TARGET.
        // Wait, pattern must be parsed as identifier?
        // "int $x = 0;". $x is an identifier.
        // "if ($cond) ...". $cond is identifier.
        // So we look for pattern nodes that are IDENTIFIERS and start with $.

        // 1. Check for valid placeholder/wildcard in pattern
        // Matches "$name" or "$name;" (statement wrapper)
        const match = pattern.text.trim().match(/^\$([a-zA-Z0-9_]+);?$/);
        if (match) {
            const name = match[1];

            // Check constraints
            if (constraints.has(name)) {
                // allowedTypes is Array<{type: string, not: boolean}>
                const constraintSpecs = constraints.get(name);

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
             // Exception: sometimes tree-sitter wraps things differently?
             // e.g. parenthesized_expression vs expression?
             // stick to strict for now.
             return false;
        }

        // 3. Leaf check (text match for keywords/literals)
        if (target.childCount === 0 && pattern.childCount === 0) {
            return target.text === pattern.text;
        }

        // 4. Children check
        // Need to match significant children (skip comments?)
        // Let's filter comments from both.
        const targetChildren = this.getChildren(target);
        const patternChildren = this.getChildren(pattern);

        if (targetChildren.length !== patternChildren.length) return false;

        for (let i = 0; i < targetChildren.length; i++) {
            if (!this.structuralMatch(targetChildren[i], patternChildren[i], captures, constraints)) {
                return false;
            }
        }

        return true;
    }

    getChildren(node) {
        const kids = [];
        for (let i = 0; i < node.childCount; i++) {
            if (node.child(i).type !== 'comment') {
                kids.push(node.child(i));
            }
        }
        return kids;
    }

    /**
     * Pre-processes pattern string to extract constraints.
     * @param {string} patternStr
     * @returns {{cleanPattern: string, constraints: Map<string, Array<{type: string, not: boolean}>>}}
     */
    preprocessPattern(patternStr) {
        const constraints = new Map();
        // Match any potential wildcard starting with $
        const cleanPattern = patternStr.replace(/\$([a-zA-Z0-9_]+)/g, (match, rawId) => {
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
     * @returns {{name: string, types: Array<{type: string, not: boolean}>}}
     */
    parseWildcard(rawId) {
        // Current syntax: name__type1__type2
        // If type starts with NOT_, it's a negative constraint.
        const parts = rawId.split('__');
        const name = parts[0];
        const rawTypes = parts.slice(1);

        const types = rawTypes.map(t => {
            if (t.startsWith('NOT_')) {
                return { type: t.slice(4), not: true };
            }
            return { type: t, not: false };
        });

        return { name, types };
    }
}
