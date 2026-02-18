# Macro Processing in UPP

UPP transforms C code with macro extensions into standard C through a multi-phase process that leverages Tree-sitter for parsing while maintaining high performance and ergonomic API for macro authors.

## Phase 0: The C pre-processor is run on the .cup file

The C pre-processor is run on the .cup file to resolve all non-C syntax that might be present in the file. This includes `#include` and `#define` directives, and conditional compilation directives if the command line contains `-D` or `-U` options. The macro substituion is then guaranteed clean C code.

## Phase 1: Macro Discovery & Preparation

Before parsing the AST, UPP performs a quick top-level scan to register macros and prepare the source code. `@define` and `@include` must be "top-level" macro invocations, and are not C syntax, so they are stripped out at this stage.

### 1.1 Discovery
- **`@include`**: Scanned first to load external dependencies (which may contain `@define`).
- **`@define`**: Registered in the global macro registry.
- **Comment Awareness**: UPP uses a preliminary parse to ensure macros inside C comments are ignored during this phase.

### 1.2 Preparation (`prepareSource`)
To make the source valid C for Tree-sitter:
1. **Strip `@define`**: Macro definitions are removed.
2. **Handle `@include`**: Converted to standard `#include` directives, generating a corresponding `.h` file for interfacing with standard .c files.
3. **Wrap Invocations**: Macro calls like `@allocate(100)` are wrapped in comments: `/*@allocate(100)*/`. This preserves the invocation in a way that doesn't break the C parser.

## Phase 2: Depth-First Transformation (DFT)

UPP walks the AST depth-first. When it encounters a `comment` node that matches a macro invocation, it evaluates it.

1. **Evaluation**: The macro function is executed with a `upp` helper object.
2. **Recursive Transpilation**: If a macro returns a string containing a `@`, that string is recursively transpiled. This allows macros to generate code that contains other macro calls, *except* for `@include` and `@define` which must be at the top level and available in phase 1.
3. **Splicing**: Results are spliced back into the source. 

## Phase 3: Advanced Transformation Engine

UPP supports complex transformations that go beyond simple text replacement.

In general, a macro will consume 0 or more nodes following it's invocation, and replace the range of those nodes with some other content by returning a replacement string. Returning `null` implies the node should be removed. Returning `undefined` or `void` is a no-op. The actual invocation node is always removed.

Using the upp API, a macro can also request modification of other nodes in the tree. For example a macro to rename an identifier of the form `@rename(new_name) int x;` will consume the declaratiion node following it, but will also need to find all the references to the identifier and rename them. It does this using the `upp.withReferences` (cf withScope, withRoot, withNode, etc). The `withReferences` callback is passed the node(s) to be renamed. The new name is referenced through a closure. 

The callback can immediately modify nodes that are children/elder siblings of the current node (since we are a depth-first traversal, everything under the current node and left-hand siblings will have already been processed). For any references that are right-hand or ancestors, the node is marked with the callback & context, and will be processed when the recusrsive tree-walk finally reaches it. The stability of node references means any markers placed on a node will be preserved through the tree-walk.

### 3.1 Deferred Transformations
Macros can register callbacks to be executed on other parts of the tree (e.g., at the root or within a specific scope).
- **`withNode(node, callback)`**: Queues a transformation for a specific node to be applied when the DFS reaches it.
- **`withRoot(callback)`**: Queues a transformation to be applied at the end of the root node's processing.

---

## The Macro Helper API (`upp`)

Macro authors interact with the system through the `upp` object passed to the macro function. You can read the full API in the [helper API](./helpers.md) section.

## Standard Library (`std/`) Status

UPP comes with a set of standard library macros that can be found in the `std/` directory. You can read more about them in the [standard library](./std.md) section.

## Best Practices for Macro Authors

1. **Use `upp.code`**: Always use the `code` tagged template for generating replacements to ensure embedded nodes are handled correctly.
2. **Prefer Pattern Matching**: Use `upp.match` and `upp.matchReplace` instead of manual tree traversal where possible.
3. **Be Specific with `consume`**: Provide clear error messages when `consume` fails to help users debug their code.
4. **Idempotency**: Ensure that your macros can be run multiple times or in nested contexts without side effects (unless intentional).
