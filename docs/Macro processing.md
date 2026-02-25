# Macro Processing in UPP

UPP transforms C code with macro extensions into standard C through a multi-phase process that leverages Tree-sitter for parsing while maintaining high performance and an ergonomic API for macro authors.

## Phase 0: The C pre-processor is run on the .cup file

The C pre-processor is run on the .cup file to resolve all non-C syntax that might be present in the file. This includes `#include` and `#define` directives, and conditional compilation directives if the command line contains `-D` or `-U` options. The macro substitution is then guaranteed clean C code.

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

UPP walks the AST pre-order, depth-first. For each node:

1. **Macro Evaluation**: If the node is a `comment` containing a wrapped macro invocation, the macro function is executed with the `upp` helper object.
2. **Pending Rule Matching**: All registered pending rules are checked against the node. Rules from `withPattern`, `withMatch`, `withReferences`, `withNode`, `withRoot`, and `withScope` are all evaluated through this single mechanism.
3. **Recursive Transpilation**: If a macro returns a string containing a `@`, that string is recursively transpiled. This allows macros to generate code that contains other macro calls, *except* for `@include` and `@define` which must be at the top level.
4. **Splicing**: Results are spliced back into the source via `helpers.replace`.

## Phase 3: Fixed-Point Rule Evaluation

After the full walk, UPP enters a fixed-point loop (`evaluatePendingRules`) that re-evaluates all pending rules against all nodes in the tree. This catches references and patterns that weren't visible during the walk — for example, nodes that were inserted by earlier macros. The loop repeats until no more rules fire (up to 5 iterations).

## The Node Consumption API

A macro will typically consume 0 or more nodes following its invocation, and replace the range of those nodes with other content by returning a replacement.

- **`consume()`**: Absorbs the next sibling node, removing it from the walker's path.
- **`nextNode()`**: Peeks at the next sibling without consuming it (useful for analysis before transformation).
- **Return values**: `string` or `SourceNode` → replacement. `null` → remove. `undefined`/`void` → no-op.

## Deferred Transformations

Using the `upp` API, a macro can request modification of other nodes in the tree. For example, `@rename(new_name) int x;` consumes the declaration but also needs to find all references to `x` and rename them. It does this using `upp.withReferences`.

The callback can immediately modify nodes that are children/elder siblings of the current node (since we use depth-first traversal, everything under the current node and left-hand siblings will have already been processed). For any references that are right-hand or ancestors, the node is tracked via a pending rule and will be processed when the walk reaches it, or during the final fixed-point sweep.

---

## The Macro Helper API (`upp`)

Macro authors interact with the system through the `upp` object passed to the macro function. You can read the full API in the [helper API](./helpers.md) section.

## Standard Library (`std/`) Status

UPP comes with a set of standard library macros that can be found in the `std/` directory. You can read more about them in the [standard library](./std.md) section.

## Best Practices for Macro Authors

1. **Use `upp.code`** (or `$`): Always use the `code` tagged template for generating replacements to ensure embedded nodes are moved rather than cloned.
2. **Prefer `withMatch`**: For pattern-based global transforms, use `upp.withMatch(scope, pattern, cb)` instead of manual tree traversal.
3. **Use `withPattern`**: For AST-type-based transforms (matching `call_expression`, `return_statement`, etc.), use `withPattern`.
4. **Be Specific with `consume`**: Provide clear type constraints to `consume`/`nextNode` to help users debug macro usage.
5. **Think Reactively**: Register deferred rules rather than imperative tree walks. Let the engine handle evaluation ordering.
