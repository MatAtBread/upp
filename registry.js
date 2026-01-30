const Parser = require('tree-sitter');
const { Query } = Parser;
const C = require('tree-sitter-c');
const fs = require('fs');
const { reportError } = require('./errors');
const { UppHelpers } = require('./upp_helpers');

class Registry {
    constructor() {
        this.parser = new Parser();
        this.parser.setLanguage(C);
        this.macros = new Map();
        this.invocations = [];
        this.sourceCode = '';
        this.filePath = '';
        this.transforms = [];
        this.helpers = new UppHelpers(this);
    }

    registerFile(filePath) {
        this.filePath = filePath;
        this.sourceCode = fs.readFileSync(filePath, 'utf8');
        const regex = /@define(?:@(\w+))?\s+(\w+)\s*\((node[^)]*)\)\s*\{/g;
        let match;
        while ((match = regex.exec(this.sourceCode)) !== null) {
            const [fullMatch, langTag, name, params] = match;
            const bodyStart = match.index + fullMatch.length;
            const body = this.extractBody(this.sourceCode, bodyStart);
            if (body !== null) {
                this.macros.set(name, {
                    language: langTag || 'js',
                    params: params.split(',').map(s => s.trim()),
                    body: body.trim(),
                    startIndex: match.index,
                    endIndex: bodyStart + body.length + 1
                });
                console.log(`Registered macro: @${name} (Language: ${langTag || 'js'})`);
            }
        }
    }

    extractBody(source, startOffset) {
        let depth = 1;
        let i = startOffset;
        while (depth > 0 && i < source.length) {
            if (source[i] === '{') depth++;
            if (source[i] === '}') depth--;
            i++;
        }
        return depth === 0 ? source.substring(startOffset, i - 1) : null;
    }

    findInvocations(tree, source) {
        tree = tree || this.mainTree || this.parser.parse(this.sourceCode);
        source = source || this.sourceCode;

        const invocations = [];
        const seenIndices = new Set();

        const walk = (node) => {
            if (node.type === 'ERROR') {
                const nodeText = node.text.trim();
                if (nodeText === '@' || nodeText.startsWith('@')) {
                    if (!seenIndices.has(node.startIndex)) {
                        const invocation = this.absorbInvocation(source, node.startIndex);
                        if (invocation && this.macros.has(invocation.name)) {
                            invocations.push({
                                ...invocation,
                                invocationNode: node
                            });
                            seenIndices.add(node.startIndex);
                        }
                    }
                }
            }
            for (let i = 0; i < node.childCount; i++) walk(node.child(i));
        };
        walk(tree.rootNode);
        return invocations;
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
        let iterations = 0;
        const maxIterations = 5;
        let modified = true;

        while (modified && iterations < maxIterations) {
            modified = false;

            this.mainTree = this.parser.parse(this.sourceCode);
            this.invocations = this.findInvocations(this.mainTree, this.sourceCode);

            if (this.invocations.length === 0) {
                // Apply transformations one last time even if no macros remain
                this.helpers.replacements = [];
                this.applyTransforms(this.mainTree, this.helpers);
                if (this.helpers.replacements.length > 0) {
                    this.applyChanges([]); // Only transforms
                    modified = true;
                    iterations++;
                    continue;
                }
                break;
            }

            this.helpers.replacements = [];
            this.evaluateMacros(this.invocations, this.sourceCode, this.helpers);
            this.applyTransforms(this.mainTree, this.helpers);

            this.applyChanges(this.invocations);
            modified = true;
            iterations++;
        }

        return this.finishProcessing();
    }

    evaluateMacros(invocations, source, helpers) {
        let cleanSource = source;
        const allStrippable = Array.from(this.macros.values()).map(m => ({ start: m.startIndex, end: m.endIndex }))
            .concat(invocations.map(i => ({ start: i.startIndex, end: i.endIndex })))
            .sort((a, b) => b.start - a.start);

        for (const range of allStrippable) {
            if (range.start >= 0 && range.end <= cleanSource.length) {
                const text = cleanSource.slice(range.start, range.end);
                const replacement = text.replace(/[^\r\n]/g, ' ');
                cleanSource = cleanSource.slice(0, range.start) + replacement + cleanSource.slice(range.end);
            }
        }

        this.mainTree = this.parser.parse(cleanSource);
        helpers.root = this.mainTree.rootNode;

        for (const invocation of invocations) {
            const macro = this.macros.get(invocation.name);
            if (!macro) continue;
            const macroFn = new Function(macro.params.join(','), 'upp', macro.body);

            try {
                let searchIndex = invocation.endIndex;
                while (searchIndex < cleanSource.length && /\s/.test(cleanSource[searchIndex])) searchIndex++;
                let targetNode = this.mainTree.rootNode.namedDescendantForIndex(searchIndex);
                if (targetNode) {
                    while (targetNode.parent && targetNode.parent.startIndex === targetNode.startIndex) targetNode = targetNode.parent;
                }
                helpers.contextNode = targetNode;
                helpers.invocation = invocation;
                const result = macroFn(targetNode, ...invocation.args, helpers);
                helpers.contextNode = null;
                if (result !== undefined) helpers.replace(targetNode, result);
            } catch (err) {
                if (err.isUppError) {
                    this.reportError(err.node, err.message);
                } else {
                    console.error(`Evaluation error in @${invocation.name}: ${err.message}`);
                }
                process.exit(1);
            }
        }
    }

    reportError(node, message) {
        reportError(node, this.sourceCode, message, this.filePath);
    }

    applyChanges(currentInvocations) {
        let output = this.sourceCode;
        const macroStripping = currentInvocations.map(i => ({ start: i.startIndex, end: i.endIndex, content: '' }));
        const allChanges = [...this.helpers.replacements, ...macroStripping]
            .filter(c => !c.isLocal) // Only main tree replacements
            .sort((a, b) => b.start - a.start || b.end - a.end);

        // Deduplicate or resolve overlaps (simple version: prefer earlier in sort)
        let lastStart = Infinity;
        for (const change of allChanges) {
            if (change.end <= lastStart) {
                output = output.slice(0, change.start) + change.content + output.slice(change.end);
                lastStart = change.start;
            }
        }
        this.sourceCode = output;
        this.helpers.replacements = [];
    }

    finishProcessing() {
        let output = this.sourceCode;
        const definitions = Array.from(this.macros.values()).map(m => ({ start: m.startIndex, end: m.endIndex, content: '' }))
            .sort((a, b) => b.start - a.start);
        for (const change of definitions) {
            output = output.slice(0, change.start) + change.content + output.slice(change.end);
        }
        return output;
    }

    expand(text, contextNode) {
        const fragmentHelpers = new UppHelpers(this);
        fragmentHelpers.contextNode = contextNode;
        fragmentHelpers.root = this.helpers.root;

        const snippetParser = new Parser();
        snippetParser.setLanguage(C);
        const tree = snippetParser.parse(text);

        this.applyTransforms(tree, fragmentHelpers);

        // IMPORTANT: In multi-pass mode, expand does NOT evaluate macros.
        // It only prepares the snippet for the next pass.

        let output = text;
        const allLocal = fragmentHelpers.replacements.filter(c => c.isLocal).sort((a, b) => b.start - a.start);
        for (const change of allLocal) {
            output = output.slice(0, change.start) + change.content + output.slice(change.end);
        }
        return output;
    }

    isInsideInvocation(start, end) {
        return this.invocations.some(inv => (start < inv.endIndex && end > inv.startIndex));
    }

    registerTransform(transformFn) {
        this.transforms.push(transformFn);
    }

    createQuery(pattern) {
        return new Query(C, pattern);
    }

    applyTransforms(tree, helpers) {
        for (const transform of this.transforms) {
            transform(tree, helpers);
        }
    }
}

module.exports = { Registry };
