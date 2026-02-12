# Audit and Re-implementation Results

## Core Engine Fixes

Several bugs were identified in the core engine that prevented many examples from working correctly:

1.  **Registry `@define` extraction**: The previous implementation corrupted indices by slicing the source string while iterating through matches. Fix: collected all definitions and applied them in reverse order.
2.  **`UppHelpersC.hoist` error**: The `hoist` method was incorrectly referencing `this.helpers` instead of `this.root`. Fix: updated to use the correct property.
3.  **Parser Robustness**: Large files (like system headers on macOS) or empty transformed outputs could cause `tree-sitter` to crash. Fix: added protective checks in `Registry.transform` and `SourceTree` constructor.

## Example Re-implementations

The following examples were updated to use current stable APIs:

### [MODIFY] [find_refs_test.cup](file:///Users/matinmontferrier/git/upp/examples/find_refs_test.cup)
- Added missing `#include <stdio.h>`.
- Updated `@rename` macro to use `upp.nextNode()` (instead of `contextNode`) and `upp.withReferences()` for stable, deferred renaming.

### [MODIFY] [consume_rename.cup](file:///Users/matinmontferrier/git/upp/examples/consume_rename.cup)
- Added missing `#include <stdio.h>`.
- Updated `@rename_context` and `@rename_consume` to use `withReferences()` to ensure all external references are updated correctly and safely.

### [MODIFY] [import.cup](file:///Users/matinmontferrier/git/upp/examples/import.cup)
- Added missing `#include <stdio.h>`.

## Remaining Issues

Some tests like `import.cup` still have compilation errors in the C output because the underlying macros (like the namespace rule in `import.hup`) might need further refinement or the library headers they depend on (`io-lite.h`) are incomplete. Per your instructions, I have not attempted to re-implement missing APIs, only fix what could be fixed with the existing infrastructure.
