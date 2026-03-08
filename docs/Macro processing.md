# Macro Processing in UPP

UPP transforms C code with macro extensions into standard C through a multi-phase process that leverages Tree-sitter for parsing while maintaining high performance and an ergonomic API for macro authors. 

UPP operates as a hybrid system:
- **The Meta-Compiler**: The JavaScript logic (`Registry`, `Transformer`, and `upp` helpers) manages state, finds macros, and coordinates transformation rules.
- **The Target AST**: Stable, persistent wrappers around the `tree-sitter` C parser (`SourceTree` and `SourceNode`). The goal of UPP is to walk the Target AST and allow the Meta-Compiler to surgically modify it.

## Phase 0: Preparing source for parsing

The C pre-processor is run on the .cup file to resolve all non-C syntax that might be present in the file. This includes `#include` and `#define` directives, and conditional compilation directives if the command line contains `-D` or `-U` options. The macro substitution is then guaranteed clean C code.

## Phase 1: Macro Discovery & Preparation

Before parsing the AST, UPP performs a quick top-level scan to register macros and prepare the source code. `@define` and `@include` must be "top-level" macro invocations.

### 1.1 Discovery
- **`@include`**: Scanned first to load external dependencies (which may contain `@define`).
- **`@define`**: Registered in the global macro registry.

### 1.2 Preparation (`prepareSource`)
To make the source valid C for Tree-sitter:
1. **Strip `@define`**: Macro definitions are removed.
2. **Handle `@include`**: Converted to standard `#include` directives, generating a corresponding `.h` file for interfacing with standard .c files.
3. **Wrap Invocations**: Macro calls like `@allocate(100)` are wrapped in comments: `/*@allocate(100)*/`. This preserves the invocation in a way that doesn't break the C parser.

## Phase 2: The Generator-Based Evaluation Walk

Once preliminary macros have executed and the tree is stable, UPP begins the main transformation process.

UPP uses a **generator-based, depth-first back-tracking walker**. This walker avoids traditional recursion, safely operating on highly dynamic AST structures.

1. **Deepest Unvisited First**: The walker repeatedly scans from the AST root to find the deepest node that has not yet been processed (i.e. not in the `done` set).
2. **Rule Evaluation**: It yields this node to the transformation pipeline. Here, all active rules are evaluated against the node.
3. **Execution & Morphing**: If a rule matches, its callback executes. 
   - If the rule replaces the node, the new unvisited structure is naturally picked up during the walker's next descent.
   - If the rule modifies a node *in-place* (identity morph), the node and its ancestors are marked for re-visiting via `upp.revisit()`.
4. **Ascension**: Because the walker always seeks the deepest unprocessed node, it ensures a post-order traversal: children are entirely evaluated and locked as `done` before evaluating the parent.

This generator mechanism guarantees that **newly injected nodes are always discovered and processed** before ascending. Macros working on parent nodes will always see fully expanded, final states of their children.


## The Node Consumption API

A macro will typically consume 0 or more nodes following its invocation, and replace the range of those nodes with other content by returning a replacement.

- **`consume()`**: Absorbs the next sibling node, removing it from the walker's path.
- **`nextNode()`**: Peeks at the next sibling without consuming it (useful for analysis before transformation).
- **Return values**: `string`, `SourceNode`, `string[]`, or `SourceNode[]` -> replacement. `null` -> remove. `undefined`/`void` -> no-op.

## Deferred Transformations

A macro can request modification of other nodes in the tree using deferred rules (e.g., `upp.withReferences`, `upp.withMatch`, `upp.withPattern`).

Because macros act on nodes that have already had their children fully transformed, any rules registered inherently target ancestor nodes, sibling nodes, or parts of the tree yet to be fully exited. The unified generator-based exit-evaluation guarantees that these deferred rules will appropriately fire as the walker ascends out of their respective scopes. Rules are reactive, running as each node enters its finalized state.

---

## Best Practices for Macro Authors

1. **Use `upp.code`** (or `$`): Always use the `code` tagged template for generating replacements to ensure embedded nodes are moved rather than cloned.
2. **Prefer `withMatch`**: For pattern-based global transforms, use `upp.withMatch(scope, pattern, cb)` instead of manual tree traversal.
3. **Use `withPattern`**: For AST-type-based transforms (matching `call_expression`, `return_statement`, etc.), use `withPattern`.
4. **Be Specific with `consume`**: Provide clear type constraints to `consume`/`nextNode` to help users debug macro usage.
5. **Think Reactively**: Register deferred rules rather than imperative tree walks. Let the engine handle evaluation ordering.
