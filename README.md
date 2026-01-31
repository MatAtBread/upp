# UPP: Universal Pre-Processor

UPP is a powerful macro pre-processor for C (and other languages) that leverages the **Tree-sitter** AST for intelligent, context-aware code transformations. Unlike traditional string-based pre-processors (like the C pre-processor), UPP allows you to write macros that understand the syntax and semantics of your code.

## Installation

<!-- User will fill this in later -->
```bash

```

## What is UPP?

UPP allows you to define custom macros that can inspect the abstract syntax tree (AST) of your source code, modify it, or generate new code. This enables features like struct methods, automatic defer, closures, and more, all in standard C.

### Example: `@trace`

The `@trace` macro decorates a function and automatically inserts a `puts` statement to print the function's name whenever it is entered. It uses `upp.consume()` to grab the function following the macro.

```javascript
@define trace() {
    const fnNode = upp.consume(); // node is the function_definition
    const { name } = upp.getFunctionSignature(fnNode);
    const body = fnNode.childForFieldName('body');

    // Insert at the start of the function body (after the opening brace)
    upp.replace({start: body.startIndex + 1, end: body.startIndex + 1},
        `\n    puts("Entering function: ${name}");`);
}
```

**Running UPP:**

```bash
upp my_file.c
```

**Output:**

```c
/* upp my_file.c */

#include <stdio.h>

void my_function() {
    puts("Entering function: my_function");
    printf("Doing something...\n");
}

int main() {
    my_function();
    return 0;
}
```

Like other C, macros can be defined in header files and included in multiple source files, allowing you to create powerful, reusable abstractions across your project.

## How to Write Macros

Macros are defined using the `@define` keyword. Within the definition body, you can write standard JavaScript. You are provided with:
1.  **Parameters**: Any arguments passed to the macro (e.g., `arg1`, `arg2`).
2.  **`upp`**: The magic helper object for navigating and manipulating the AST.
3.  **`console`**: Standard Node.js console for debugging.

A good place to start is to go to https://tree-sitter.github.io/tree-sitter/7-playground.html. This allows you to see how tree-sitter parses C code and the format of the trees it generates. The macro code will typically execute the logic required to transform one tree into another by cutting, pruning, moving and updating the nodes.

### Replacement vs. Consumption

Understanding the difference between **Replacement** and **Consumption** is key to mastering UPP.

#### 1. Replacement (The Return Value)
By default, a macro **replaces its own invocation** (`@my_macro(...)`) with whatever string it returns.
```javascript
@define my_macro() {
    return "int x = 10;";
}
// Usage: @my_macro() -> int x = 10;
```

#### 2. Consumption (`upp.consume()`)
If you want a macro to "grab" and modify the code that follows it (like a decorator), you use `upp.consume()`. This helper:
-   Finds the next AST node.
-   Removes it from the source (registers a replacement to `""`).
-   Returns the node object to your JavaScript code.

By combining these, you can "wrap" or "transform" entire code blocks.

### Advanced Navigation

Sometimes you need to look outside the immediate vicinity of the macro invocation.

-   **`upp.root`**: This is the root node of the entire file. You can use it to perform global searches using `upp.query(pattern, upp.root)` or `upp.findReferences(someNode)`.
-   **`upp.findEnclosing(node, type)`**: Finds the nearest parent node of a specific type (e.g., `compound_statement` or `function_definition`). This is useful for macros like `@defer` that need to know their containing scope.

### The `upp` Object Helpers

-   `upp.replace(nodeOrRange, text)`: Replaces a specific part of the code.
-   `upp.code` (template literal): Generates code strings with proper indentation and nesting.
-   `upp.query(pattern, [node])`: Executes an S-expression query on the AST.
-   `upp.getType(node)`: Automatically resolves the C type of a variable or expression.
-   `upp.findReferences(node)`: Finds all usages of a local or global symbol.
-   `upp.hoist(code)`: Moves code to the top of the file (e.g., for generated structures or helper functions).
-   `upp.getFunctionSignature(fnNode)`: Parses a function definition into its name, return type, and parameters.

## Standard Library Macros
... (rest of the file)

UPP comes with a set of powerful standard macros in the `std/` directory.

### `@method(Type)`
Enables C++ style method syntax for C structs.
- **Example**: `p.distance()` -> `_Point_method_distance(&p)`
- **File**: `std/method.h`

### `@defer code;`
Schedules a piece of code to run at the end of the current scope.
- **Example**: `@defer free(ptr);`
- **File**: `std/defer.h`

### `@async`
Simplifies asynchronous function calls.
- **Example**: `@async my_task();`
- **File**: `std/async.h`

### `@lambda`
Provides support for anonymous functions and closures in C. The macro will automatically capture all variables in the current scope that are used in the lambda.
- **Example**: `char *salutation = "Hello"; @lambda int greet(const char *name) { printf("%s %s\n", salutation, name); };`
- **File**: `std/lambda.h`

### `@trap(handler)`
Intercepts assignments to variables or struct fields and pipes them through a handler.
- **Example**: `@trap(log_change) int x;`
- **File**: `std/trap.h`

### `@fieldsof(Type)`
Implements basic structural inheritance by copying fields from one struct to another.
- **Example**: `struct Derived { @fieldsof(struct Base); int extra; };`
- **File**: `std/fieldsof.h`

### `@forward`
Automatically generates forward declarations for all functions in the current file.
- **File**: `std/forward.h`

### The `node` Parameter vs. `upp.consume()`

When defining a macro, you have two primary ways to target the code following the macro invocation:

1.  **The `node` Parameter (Decorator Style)**:
    If your macro's first parameter is named exactly `node`, UPP treats it as a **decorator**. The `node` variable will automatically contain the Tree-sitter AST node immediately following the macro invocation.
    ```javascript
    @define trace(node) { ... } // Targets the next node (e.g., a function definition)
    ```

2.  **`upp.consume()` (Command Style)**:
    If your macro does *not* use a `node` parameter, it is treated as a standalone command. You can use the `upp.consume()` helper to manually "grab" the next node(s) in the AST. This is useful for macros that process blocks of code or multiple subsequent syntax elements.
    ```javascript
    @define defer() {
        const statement = upp.consume(); // Grabs the next statement
        // ... logic to move it to the end of scope
    }
    ```

