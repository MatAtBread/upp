# UPP Helpers API Documentation

The `upp` object available in macros and transformation rules provides a rich set of utilities for inspecting and modifying source code.

## 1. Core Utilities (`UppHelpersBase`)

These utilities are always available in any UPP environment.

### Source Modification
- `node.text = "..."`: **[SAFE & RECOMMENDED]** Direct assignment to a node's source. This automatically re-parses the new text and morphs the node structure to match the new code.
- `upp.replace(node, content)`: Alias for `node.text = content`. Useful inside `code` template literals as it returns an empty string to avoid adding unwanted text to the output.
- `upp.consume(types, [message])`: "Consumes" the next logical node if it matches the specified `types`. The node is removed from the normal source flow and returned.
- `upp.nextNode(types)`: Returns the next logical node without removing it. Useful for peeking.
- `upp.code\`source\``: Tagged template literal for generating source fragments. Nodes passed as interpolations will automatically use their source text.

### Tree Traversal & Query
- `upp.query(selector)`: Finds nodes matching a simple type string (e.g., `"function_definition"`).
- `upp.findRoot()`: Returns the root node of the current file.
- `upp.findParent(node)`: Returns the parent of the specified node.
- `upp.findScope(node)`: Returns the closest enclosing scope (`compound_statement` or `function_definition`).
- `upp.findInvocations(macroName)`: Returns a list of all occurrences of a specific macro call.

### Transformation Control
- `upp.withNode(node, callback)`: Attaches a deferred transformation to a specific node. The callback will be executed once the current transformation pass reaches that node.
- `upp.registerTransformRule(rule)`: Registers a dynamic transformation rule that applies to the entire file (both existing and generated code). See below for details.

### Infrastructure
- `upp.loadDependency(file)`: Loads and processes another file as a dependency.
- `upp.isConsumed(node)`: Returns `true` if the node has been removed via `upp.consume`.

---

## 2. C-Specific Utilities (`UppHelpersC`)

Available when transpiling C code.

### Pattern Matching
- `upp.match(node, pattern, [callback])`: Matches a source fragment pattern against a node.
- `upp.matchAll(node, pattern)`: Returns all occurrences of a pattern within a sub-tree.
- `upp.matchReplace(node, pattern, callback)`: Finds a pattern match and replaces the matching node with the result of the callback.

### C Analysis
- `upp.getType(node)`: Extracts the C type string (e.g., `int *`) for a variable or parameter.
- `upp.getFunctionSignature(node)`: Returns an object containing `name`, `returnType`, `params`, and `bodyNode` for a function definition.
- `upp.findDefinition(node|name)`: Resolves an identifier to its declaration node.
- `upp.findReferences(node)`: Finds all usages of a specific declaration.

### Advanced Transformations
- `upp.withReferences(definitionNode, callback)`: Registers a dynamic rule to transform all current and future references to a specific definition.
- `upp.withDefinition(target, callback)`: Finds the definition for a name/node and applies a transformation.
- `upp.hoist(content)`: Prepends source code to the top of the file.

---

## 3. The `upp` Macro Context

When inside a macro implementation, the `upp` object also provides access to:

- `upp.registry`: The current `Registry` instance managing the file.
- `upp.parentHelpers`: Helpers for the file that *included* the current one. Essential for cross-file introspection (like `@package` checking the implementation file).
- `upp.path`: The standard Node.js `path` module.
- `upp.invocation`: Metadata about the current macro call (name, arguments, line, etc.).
- `upp.stdPath`: The absolute path to the UPP standard library directory.

---

## 4. Understanding `upp.registerTransformRule`

`upp.registerTransformRule` is the primary mechanism for implementing **dynamic rewriters**. 

Unlike a standard macro that runs exactly once when encountered, a transformation rule persists for the entire transformation pass. It is checked against every node in the AST as the tree is walked.

### Rule Structure
```javascript
upp.registerTransformRule({
    id: "unique_id",
    type: "pattern",
    active: true,
    matcher: (node, helpers) => {
        // Return true if this rule should apply to 'node'
        return node.type === 'call_expression' && node.text === 'old_func';
    },
    callback: (node, helpers) => {
        // Return a string to replace the node, or undefined to skip
        return "new_func" + node.text.slice(8);
    }
});
```

### Why use rules?
Rules are essential for transformations that must apply to **generated code**. 
For example, if the `@package(mypkg)` macro renames all functions in a file, it registers a rule to ensure that any *other* macro call that later generates code referencing those functions will also have those references renamed correctly.
