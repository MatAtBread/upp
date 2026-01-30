class UppHelpers {
    constructor(registry) {
        this.registry = registry;
        this.replacements = [];
        this.root = null;
        this.contextNode = null;
        this.invocation = null; // Current macro invocation details
    }

    debug(node) {
        console.log(`Debug Node: type=${node.type}, text="${node.text.slice(0, 50)}${node.text.length > 50 ? '...' : ''}"`);
    }

    code(strings, ...values) {
        let rawText = '';
        for (let i = 0; i < strings.length; i++) {
            rawText += strings[i];
            if (i < values.length) {
                const val = values[i];
                if (val && typeof val === 'object' && val.text !== undefined) {
                    rawText += val.text;
                } else {
                    rawText += String(val);
                }
            }
        }

        const expandedText = this.registry.expand(rawText, this.contextNode);

        return {
            type: 'upp_fragment',
            text: expandedText,
            get tree() {
                return this.registry.parser.parse(this.text);
            }
        };
    }

    replace(n, newContent) {
        const start = n.startIndex !== undefined ? n.startIndex : n.start;
        const end = n.endIndex !== undefined ? n.endIndex : n.end;

        // Robust check: does this node belong to the main tree?
        let isGlobal = false;
        if (n.tree) {
            isGlobal = this.registry.mainTree && (n.tree === this.registry.mainTree);
        } else {
            // Manual range. Assume global if we are the main helpers instance.
            isGlobal = (this === this.registry.helpers);
        }

        if (isGlobal && this.registry.isInsideInvocation(start, end)) {
            // Some transforms should happen even inside macros, but for now we skip
            // to avoid overlapping replacement issues during development.
            // Exception: if the current macro IS this range, it's allowed.
            if (!(this.invocation && this.invocation.startIndex === start && this.invocation.endIndex === end)) {
                return;
            }
        }

        const replacement = {
            start: start,
            end: end,
            content: typeof newContent === 'object' ? newContent.text : String(newContent),
            isLocal: !isGlobal,
            node: n
        };

        if (isGlobal && this.registry.helpers !== this) {
            this.registry.helpers.replacements.push(replacement);
        } else {
            this.replacements.push(replacement);
        }
    }

    wrapNode(node) {
        return node;
    }

    registerTransform(transformFn) {
        this.registry.registerTransform(transformFn);
    }

    walk(node, callback) {
        if (!node) return;
        const root = node.rootNode || node;
        const stack = [root];
        while (stack.length > 0) {
            const n = stack.pop();
            if (!n) continue;
            callback(n);
            for (let i = n.childCount - 1; i >= 0; i--) {
                const child = n.child(i);
                if (child) stack.push(child);
            }
        }
    }

    findEnclosing(node, type) {
        let current = node.parent;
        if (!current && this.contextNode) {
            current = this.contextNode;
        }
        while (current) {
            if (current.type === type) return current;
            current = current.parent;
        }
        return null;
    }

    nextSiblings(node) {
        const siblings = [];
        let current = node.nextSibling;
        while (current) {
            siblings.push(current);
            current = current.nextSibling;
        }
        return siblings;
    }

    query(pattern, node) {
        const root = node ? (node.rootNode || node) : this.root;
        if (!root) throw new Error("upp.query: No node or root provided.");

        const q = this.registry.createQuery(pattern);
        const matches = q.matches(root);

        // Map matches to a simpler format for macros
        return matches.map(match => {
            const captures = {};
            for (const cap of match.captures) {
                captures[cap.name] = cap.node;
            }
            return {
                node: match.captures[0].node, // First capture is the primary node
                captures: captures
            };
        });
    }

    error(node, message) {
        const err = new Error(message);
        err.isUppError = true;
        err.node = node;
        throw err;
    }
}

module.exports = { UppHelpers };
