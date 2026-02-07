# ⚠️ CRITICAL: Re-Parsing Performance Problem

**Status:** The current implementation works correctly but has exponential performance degradation with nested macros.

## The Problem

Every macro evaluation triggers a full re-parse. With nested macros, this becomes exponential:

```c
@allocate(100) char* str;  // Expands to code with @defer inside
```

**Parse operations:**
1. Parse main file → find `/*@allocate(100)*/`
2. Evaluate `@allocate` → returns string with `@defer`
3. **Parse #2:** Parse result to find `/*@defer(...)*/`
4. Evaluate `@defer` → returns string with `__UPP_DEFERRED_0__`
5. **Parse #3:** Parse result
6. **Parse #4:** Combine children, parse to find markers
7. **Parse #5:** Execute deferred callback at scope

**5+ parses for a single top-level macro!** Subtrees grow as recursion unwinds, making this O(n²) or worse.

## Root Cause: Architectural Mismatch

**What we need:** Mutable AST where nodes can be modified and code generated from the modified tree

**What Tree-sitter provides:** Immutable read-only index into source text

**The gap:** Tree-sitter nodes are just byte offsets into source. Any text modification invalidates all node positions, requiring a full re-parse. We're building a transformation system on a library designed only for parsing.

## Why This Matters

- ✅ **Small files:** Acceptable performance (< 100ms)
- ⚠️ **Medium files:** Noticeable slowdown (100-500ms)
- ❌ **Large files with deep nesting:** Prohibitively slow (> 1s)

## Potential Solutions

### 1. Accept Current Performance (Status Quo)
Works for small projects. Document the limitation.

### 2. Use tree.edit() for Incremental Parsing
Tree-sitter supports incremental updates, but requires tracking exact positions for every change. Complex and error-prone.

### 3. Build Mutable AST Layer (Recommended)
Wrap Tree-sitter nodes in mutable proxies:
- Parse once with Tree-sitter
- Track modifications in wrapper layer
- Generate text only at the end
- Single final re-parse for validation

### 4. Switch Parsers
Use a parser with mutable ASTs (libclang, custom Tree-sitter bindings). Major undertaking.

### 5. Hybrid: Defer All Transformations
- Parse once
- Collect all transformations in a plan
- Apply all at once at the end
- Single final re-parse

## Recommendation

**Option 3 (Mutable AST Layer) + Option 5 (Hybrid):**

1. Parse once with Tree-sitter
2. Build mutable wrapper nodes
3. Macros modify wrappers (no re-parsing)
4. Track deferred callbacks in Maps (no markers in source)
5. Generate final text from modified tree
6. Optional final parse for validation

This preserves Tree-sitter's excellent C parsing while avoiding the re-parsing explosion.

## Current Status

The system **works** but **doesn't scale**. For the immediate future, we accept this limitation and document it. A future refactoring to mutable AST layer would be a significant improvement.

---
