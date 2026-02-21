# UPP Architectural Explainer: The Transformation Pipeline

This document provides a comprehensive overview of how UPP transforms source code from `.cup` (C Universal Pre-processor) files into standard C. It is intended for developers working on the UPP core.

---

## 1. Overview: The "Two Worlds" Architecture

UPP operates as a hybrid system:
- **World 1: The Meta-Compiler**: The `Registry` and `UppHelpers`. This is the JavaScript logic that manages state, finds macros, and coordinates the execution of transformation rules.
- **World 2: The Target AST**: The `SourceTree` and `SourceNode`. These are stable, persistent wrappers around the `tree-sitter` C parser.

The goal of UPP is to walk the Target AST and allow the Meta-Compiler to surgically modify it until all macros and rules have been resolved.

---

## 2. The Transformation Pipeline

The transformation of a file follows a strict, recursive lifecycle:

### Phase A: Parsing & preparation
1.  **Preparation**: `Registry.prepareSource` scans the source text for `@macro(...)` invocations. It wraps them in special comments (e.g., `/*@macro(...)*/`) so the C parser perceives them as valid whitespace/comments rather than syntax errors.
2.  **Initial Parse**: The `tree-sitter-c` parser generates the initial AST. UPP wraps this in a `SourceTree`.

### Phase B: The Recursive Walk (`transformNode`)
The Registry performs a **single-pass, top-down walk** of the AST.
1.  **Macro Identification**: If a node is a `comment` containing a wrapped macro, it is "absorbed."
2.  **Macro Evaluation**: The macro's JavaScript body is executed.
    - **Isolation**: Macros can `consume` siblings or children, effectively "removing" them from the main walker's future path.
    - **Stability**: Macros frequently use `upp.code` to generate new trees.
3.  **Result Handling**: The macro returns a Result (String, Node, or Array).
4.  **Surgical Replacement**: `helpers.replace(node, result)` is called. This uses `SourceNode.replaceWith` to swap the macro invocation's text and AST node with the new content.

### Phase C: Reactive Re-Evaluation (`evaluatePendingRules`)
This is the most critical phase for non-local transformations (like ref-counting).
1.  **Fixed-Point Evaluation**: When a macro returns new nodes, UPP does not just continue walking. It enters a "Fixed-Point" loop.
2.  **The Handover Point**: Rule Matching occurs **after** a node has been officially inserted back into the main source tree via `helpers.replace`. This is the atomic boundary where a node transitions from a detached fragment to a stable part of the AST.
3.  **Rule Matching**: Every *newly inserted* node is matched against all `pendingRules` (registered via `withReferences` or `withDefinition`).
4.  **Recursion**: If a rule transforms an inserted node, the process repeats for the *newest* nodes until the tree stabilizes.

---

## 3. Referential Stability & `upp.code`

UPP values **Referential Stability** above all else. If you have a reference to a `SourceNode`, that node remains valid even if its text or position changes.

### How `upp.code` works:
When you write: `return upp.code`/* Ref */ ${target}``:
1.  **Node Movement (Not Cloning)**: The `target` node is **migrated** to a new temporary `SourceTree`.
2.  **Removal**: The `target`'s text is deleted from the original file temporarily.
3.  **Insertion**: When the macro returns, the entire new fragment is spliced back into the original tree.
4.  **Identity Preservation**: The `target` node object stays the same. Any markers or data attached to it remain attached.

**Key Rule**: Structural modifications (splicing into parents) should ideally only happen during the "Return" phase of a macro or a `withXxx` callback. Calling `helpers.replace` manually mid-macro is discouraged if you can return the result instead.

---

## 4. Edge Case Gallery: How they work

### `@refcount` & `@defer`
- **Mechanism**: `@refcount` finds a variable, then uses `withReferences` to track usages.
- **The Stability Trap**: `@defer` used to rewrite `return` statements by replacing them with strings. This destroyed the `return` node.
- **The Fix**: `@defer` now uses `insertBefore`, keeping the `return` node intact so `@refcount` can still find and transform it during the `PendingRule` phase.

### `@method`
- **Mechanism**: Relocates function code. It uses `helpers.hoist` to move code to the top-level of the translation unit. 
- **Key Point**: Because it hoists code, it must ensure that any type references inside the method are still valid at the destination scope.

### `@trap`
- **Mechanism**: A "hybrid" macro. It transforms a declaration AND uses `withReferences` to find all assignments to that variable.
- **Challenge**: It must distinguish between the *initialization* of the variable (part of the declaration) and subsequent *assignments*. It does this by checking `node.parent.type`.

### `withReferences` / `withDefinition`
- **Mechanism**: These do not transform nodes immediately during a walk. They register a `PendingRule`.
- **The Detached Node Problem**: In the `DefRef` example, `upp.code` moves a node into a fragment. If a transformation rule runs while the node is "in-flight" (between trees), `helpers.replace` will fail because the node has no parent in the original tree.
- **The Correct Pattern**: Rules must be **reactive**, never **imperative**. They should only trigger on nodes that are part of the main `SourceTree`. UPP handles this by re-evaluating rules whenever a fragment is spliced back into the main tree at the **Handover Point**.

---

## 5. Legacy & Deprecated Systems

If you see these in the codebase, be aware they are being phased out:
- **`Registry.registerTransform`**: Legacy manual transformation registration. Replaced by Procedural Macros (`@define`) and Rules (`withReferences`).
- **`Registry.executeDeferredMarkers`**: A trailing pass for markers. Mostly superseded by the recursive `transformNode` logic.
- **Manual Node Splicing**: Directly manipulating `node.parent.children` is legacy. Always use `helpers.replace`, `node.insertBefore`, or `node.insertAfter`.

---

## 6. Summary for the New Developer
- **Don't Clone**: Always move nodes using `upp.code`.
- **Think Reactively**: Use `withReferences` to handle things that might happen "later" or "elsewhere."
- **Stay in the Tree**: Remember that a node's context (parent/scope) is only reliable when it is attached to the main `SourceTree`.
    - **Canonical Check**: To determine if a node is currently connected to the main transformation tree, check if `node.tree === helpers.root`. If they differ, the node is in a fragment or a nested context.
