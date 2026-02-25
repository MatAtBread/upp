# UPP Architectural Explainer: The Transformation Pipeline

This document provides a comprehensive overview of how UPP transforms source code from `.cup` (C Universal Pre-processor) files into standard C. It is intended for developers working on the UPP core.

---

## 1. Overview: The "Two Worlds" Architecture

UPP operates as a hybrid system:
- **World 1: The Meta-Compiler**: The `Registry`, `Transformer`, and `UppHelpers`. This is the JavaScript logic that manages state, finds macros, and coordinates the execution of transformation rules.
- **World 2: The Target AST**: The `SourceTree` and `SourceNode`. These are stable, persistent wrappers around the `tree-sitter` C parser.

The goal of UPP is to walk the Target AST and allow the Meta-Compiler to surgically modify it until all macros and rules have been resolved.

---

## 2. The Transformation Pipeline

The transformation of a file follows a strict, recursive lifecycle:

### Phase A: Parsing & preparation
1.  **Preparation**: `Registry.prepareSource` scans the source text for `@macro(...)` invocations. It wraps them in special comments (e.g., `/*@macro(...)*/`) so the C parser perceives them as valid whitespace/comments rather than syntax errors.
2.  **Initial Parse**: The `tree-sitter-c` parser generates the initial AST. UPP wraps this in a `SourceTree`.

### Phase B: The Recursive Walk (`transformNode`)
The Transformer performs a **pre-order, depth-first walk** of the AST. For each node:

1.  **Phase 1 — Macro Identification & Evaluation**: If a node is a `comment` containing a wrapped macro invocation, the macro's JavaScript body is executed. Macros can `consume` siblings, use `upp.code` to generate trees, and register deferred rules.
2.  **Phase 2 — Pending Rules (eager pass)**: All registered `pendingRules` are checked against the current node. If a rule's matcher fires, the callback transforms the node immediately. This allows deferred rules to intercept nodes during the walk without waiting for the final sweep.
3.  **Phase 3 — Child Recursion**: The walker recurses into child nodes.

### Phase C: Reactive Re-Evaluation (`evaluatePendingRules`)
This is the most critical phase for non-local transformations (like ref-counting and method dispatch).

1.  **Fixed-Point Evaluation**: After the full walk completes, UPP enters a fixed-point loop. Every node in the tree is checked against all `pendingRules`.
2.  **The Handover Point**: Rule evaluation occurs **after** a node has been inserted into the main source tree. This is the atomic boundary where a node transitions from a detached fragment to a stable part of the AST.
3.  **Once-per-node Guard**: The `appliedRules` WeakMap ensures each rule fires at most once per node, preventing infinite loops.
4.  **Convergence**: If a rule transforms a node, the new nodes are checked against all rules. The loop repeats (up to 5 iterations) until no more rules fire.

---

## 3. The Unified Rule System

All deferred transformations go through a single `PendingRule` system:

| API | What it does | Scope |
|-----|-------------|-------|
| `withPattern(type, matcher, cb)` | Matches AST node types (e.g., `call_expression`) | Root (entire tree) |
| `withMatch(scope, pattern, cb)` | Matches structural source patterns (e.g., `$type $name;`) | Specified scope |
| `withReferences(defNode, cb)` | Matches all identifier references to a definition | Root (entire tree) |
| `withNode(node, cb)` | Fires when a specific node is reached | Specific node |
| `withRoot(cb)` | Fires on root after walk completes | Root |
| `withScope(scope, cb)` | Fires on a scope node | Specific scope |

All of these register a `PendingRule` with a `contextNode`, `matcher`, and `callback`. The transformer evaluates these rules both during the walk (Phase B, step 2) and during the final sweep (Phase C).

---

## 4. Referential Stability & `upp.code`

UPP values **Referential Stability** above all else. If you have a reference to a `SourceNode`, that node remains valid even if its text or position changes.

### How `upp.code` works:
When you write: `return upp.code`/* Ref */ ${target}`` (or equivalently `$`/* Ref */ ${target}``):
1.  **Node Movement (Not Cloning)**: The `target` node is **migrated** to a new temporary `SourceTree`.
2.  **Removal**: The `target`'s text is deleted from the original file temporarily.
3.  **Insertion**: When the macro returns, the entire new fragment is spliced back into the original tree.
4.  **Identity Preservation**: The `target` node object stays the same. Any markers or data attached to it remain attached.

**Key Rule**: Structural modifications (splicing into parents) should ideally only happen during the "Return" phase of a macro or a `withXxx` callback. Calling `helpers.replace` manually mid-macro is discouraged if you can return the result instead.

---

## 5. Edge Case Gallery

### `@refcount` & `@defer`
- **Mechanism**: `@refcount` finds a variable, then uses `withReferences` to track usages.
- **The Stability Trap**: `@defer` used to rewrite `return` statements by replacing them with strings. This destroyed the `return` node.
- **The Fix**: `@defer` now uses `insertBefore`, keeping the `return` node intact so `@refcount` can still find and transform it during the pending rule phase.

### `@method`
- **Mechanism**: Relocates function code. Uses `withPattern` to match `call_expression` nodes that look like method calls (e.g., `obj.method(args)`), transforming them into function calls with the object passed as the first argument.
- **Key Point**: Uses `helpers.code` to preserve referential stability when constructing the replacement call expression.

### `@package`
- **Mechanism**: Cross-registry transformation. A dependency file registers `withPattern` rules on the **parent's** helpers, renaming public functions to namespaced versions (e.g., `add` → `mypkg_add`).

### `withReferences`
- **Mechanism**: Registers a `PendingRule` that fires on any identifier resolving to a specific definition.
- **The Detached Node Problem**: `upp.code` moves a node into a fragment. If a rule runs while the node is "in-flight", `helpers.replace` will fail because the node has no parent in the original tree.
- **The Correct Pattern**: Rules must be **reactive**, never **imperative**. They should only trigger on nodes that are part of the main `SourceTree`.

---

## 6. Summary for the New Developer
- **Don't Clone**: Always move nodes using `upp.code` (or its `$` shorthand).
- **Think Reactively**: Use `withReferences`, `withMatch`, or `withPattern` to handle things that might happen "later" or "elsewhere."
- **Stay in the Tree**: A node's context (parent/scope) is only reliable when attached to the main `SourceTree`.
- **Prefer `withMatch`**: For pattern-based global transforms, `withMatch(root, pattern, cb)` is the idiomatic approach.
