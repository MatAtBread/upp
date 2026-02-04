/**
 * Type definitions for the UPP macro API.
 * These are used to provide autocompletion inside @define blocks.
 */

interface SyntaxNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    parent: SyntaxNode | null;
    childCount: number;
    namedChildCount: number;
    child(index: number): SyntaxNode | null;
    namedChild(index: number): SyntaxNode | null;
    childForFieldName(fieldName: string): SyntaxNode | null;
    nextSibling: SyntaxNode | null;
    prevSibling: SyntaxNode | null;
    nextNamedSibling: SyntaxNode | null;
    prevNamedSibling: SyntaxNode | null;
}

interface UppCode {
    text: string;
    tree: () => any;
}

interface UppHelpers {
    /** The root node of the entire file. */
    root: SyntaxNode;
    /** The node immediately following the macro invocation. */
    contextNode: SyntaxNode | null;

    /** Consumes the next available node, optionally validating its type. */
    consume(expectedTypeOrOptions?: string | string[] | any, errorMessage?: string): SyntaxNode | null;

    /** Replaces a node or range with new content. */
    replace(nodeOrRange: SyntaxNode | {start: number, end: number}, newContent: string | UppCode): void;

    /** Tagged template literal for generating code and parse trees. */
    code(strings: TemplateStringsArray, ...values: any[]): UppCode;

    /** Executes a tree-sitter query on the root or specified node. */
    query(pattern: string, node?: SyntaxNode): Array<{pattern: number, captures: Record<string, SyntaxNode>}>;

    /** Finds the nearest enclosing node of a specific type. */
    findEnclosing(node: SyntaxNode, type: string): SyntaxNode | null;

    /** Hoists content to the top of the file. */
    hoist(content: string, hoistIndex?: number): void;

    /** Extracts the C type string from a definition node. */
    getType(defNode: SyntaxNode): string;

    /** Extracts function signature details (returnType, name, params). */
    getFunctionSignature(fnNode: SyntaxNode): { returnType: string, name: string, params: string };

    /** Creates a unique identifier with the given prefix. */
    createUniqueIdentifier(prefix?: string): string;

    /** Reports an error associated with a node. */
    error(node: SyntaxNode, message: string): never;

    /** Registers a global transformation function. */
    registerTransform(transformFn: (root: SyntaxNode, helpers: UppHelpers) => void): void;
}

declare const upp: UppHelpers;
declare const console: Console;
