# Macro Processing in UPP

UPP transforms C code with macro extensions into standard C through a multi-phase process that leverages Tree-sitter for parsing while maintaining high performance and ergonomic API for macro authors.

## Phase 1: Macro Discovery & Preparation

Before parsing the AST, UPP performs a top-down scan to register macros and prepare the source code.

### 1.1 Discovery
- **`@include`**: Scanned first to load external dependencies (which may contain `@define`).
- **`@define`**: Registered in the global macro registry.
- **Comment Awareness**: UPP uses a preliminary parse to ensure macros inside C comments are ignored during this phase.

### 1.2 Preparation (`prepareSource`)
To make the source valid C for Tree-sitter:
1. **Strip `@define`**: Macro definitions are removed (replaced with whitespace to preserve line/column offsets).
2. **Handle `@include`**: Converted to standard `#include` directives.
3. **Wrap Invocations**: Macro calls like `@allocate(100)` are wrapped in comments: `/*@allocate(100)*/`. This preserves the invocation in a way that doesn't break the C parser.

## Phase 2: Depth-First Transformation (DFT)

UPP walks the AST depth-first. When it encounters a `comment` node that matches a macro invocation, it evaluates it.

1. **Evaluation**: The macro function is executed with a `upp` helper object.
2. **Recursive Transpilation**: If a macro returns a string, that string is recursively transpiled. This allows macros to generate code that contains other macro calls.
3. **Splicing**: Results are spliced back into the source. UPP's `Registry` manages source offsets so that subsequent transformations stay aligned.

## Phase 3: Advanced Transformation Engine

UPP supports complex transformations that go beyond simple text replacement.

### 3.1 Hoisting
Macros can "hoist" their results or replacement content to an ancestor node.
- **Mechanism**: If a macro replaces a node that is an ancestor of the current invocation, UPP detects this and redirects the transformation to the ancestor's range.
- **Example**: A macro inside a function body can replace the entire `function_definition`.

### 3.2 Deferred Transformations
Macros can register callbacks to be executed on other parts of the tree (e.g., at the root or within a specific scope).
- **`withNode(node, callback)`**: Queues a transformation for a specific node to be applied when the DFS reaches it.
- **`atRoot(callback)`**: Queues a transformation to be applied at the end of the root node's processing.

---

## The Macro Helper API (`upp`)

Macro authors interact with the system through the `upp` object passed to the macro function.

### Base Helpers (`upp.*`)

| Method | Description |
| :--- | :--- |
| `query(pattern, [node])` | Executes a Tree-sitter S-expression query. Returns an array of matches with captures. |
| `consume(type, [error])` | Consumes the next sibling node of a specific type. Useful for transformation macros. |
| `replace(node, content)` | Replaces a specific node with new text. |
| `atRoot(callback)` | Registers a callback to run on the root node after current DFS. |
| `code\`text\`` | A tagged template literal that safely embeds nodes by using their `text` property. |
| `loadDependency(file)` | Dynamically loads and transpiles a `.hup` dependency. |
| `registerParentTransform(cb)` | (Included files only) Registers a callback to run on the parent implementation file's AST. |

### C-Specific Helpers (via `UppHelpersC`)

| Method | Description |
| :--- | :--- |
| `match(node, pattern, callback)` | Matches a pattern string against a node. Supports named captures. |
| `matchReplaceAll(node, pat, cb)` | Recursively finds and replaces all matches of a pattern within a node. |
| `getDefinition(target)` | Finds the definition node for an identifier or call expression. |
| `findReferences(node)` | Finds all references to a specific definition node. |
| `getType(node)` | Extracts the C type string (e.g., `int`, `char *`) for a variable or expression. |
| `getFunctionSignature(fnNode)` | Extracts name, return type, params, and body from a `function_definition`. |
| `hoist(content)` | Utility to hoist code to the top of the file (e.g., for imports or global variables). |

---

## Standard Library (`std/`) Status

| File | Status | Description |
| :--- | :--- | :--- |
| `package.hup` | **STABLE** | Implements `@package` and `@implements`. Handles namespacing and header generation. |
| `method.hup` | **STABLE** | Implements OOP-style method calls for C structs. |
| `defer.hup` | **VALIDATING** | Implements Go-style `defer`. Needs check for complex control flow. |
| `async.hup` | **EXPERIMENTAL** | Early implementation of async/await patterns. |
| `lambda.hup` | **EXPERIMENTAL** | Experimental support for C closures/lambdas. |
| `include.hup` | **DEPRECATED** | Replaced by internal `@include` logic. |
| `forward.hup` | **VALIDATING** | Automatically generates forward declarations. |

---

## Best Practices for Macro Authors

1. **Use `upp.code`**: Always use the `code` tagged template for generating replacements to ensure embedded nodes are handled correctly.
2. **Prefer Pattern Matching**: Use `upp.match` and `upp.matchReplaceAll` instead of manual tree traversal where possible.
3. **Be Specific with `consume`**: Provide clear error messages when `consume` fails to help users debug their code.
4. **Idempotency**: Ensure that your macros can be run multiple times or in nested contexts without side effects (unless intentional).
