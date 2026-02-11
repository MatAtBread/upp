# UPP: Universal Pre-Processor

UPP is a powerful macro pre-processor for C (and other languages) that leverages the **Tree-sitter** AST for intelligent, context-aware code transformations. Unlike traditional string-based pre-processors (like the C pre-processor), UPP allows you to write macros that understand the syntax and semantics of your code.

STATUS: ALPHA

## Installation

```
npm install @matatbread/upp
```

## What is UPP?

UPP allows you to define custom macros that can inspect the abstract syntax tree (AST) of your source code, modify it and generate new code. This enables features like struct methods, automatic defer, closures, and more, all in standard C.

UPP is not a compiler. It is a pre-processor that generates C code. You will need to compile the generated C code with a C compiler of your choice. UPP comes with a utility `upp-transpile` that will generate the C code and print it to the console. It also comes with a utility `upp` that will generate the C code and compile it with a C compiler of your choice. You can also use UPP as a library in your own tools.

### Example: `@trace`

The `@trace` macro decorates a function and automatically inserts a `puts` statement to print the function's name whenever it is entered. It uses `upp.consume()` to grab the function following the macro.

```
#include <stdio.h>

@define trace() {
    const fnNode = upp.consume(); // Read the next item in the AST and remove it from the tree
    const { returnType, name, params } = upp.getFunctionSignature(fnNode);
    const body = fnNode.childForFieldName('body');

    if (body) {
        return upp.code`${returnType} ${name}${params} {
    fputs("Entering ${name}\\n", stderr);
    ${body.children.slice(1, -1).map(c => c.text).join('\n\t')}
}`;
    }
}

@trace int my_function(int x) {
    int g = 1;
    for (int i=0; i < x; i++) {
        g = g * i;
    }
    return g;
}

int main() {
    printf("magic number %d\n", my_function(1));
    return 0;
}
```

```bash

$ upp-transpile examples/trace.cup
========================================
FILE: examples/trace.cup
========================================

int my_function(int x) {
    fputs("Entering my_function\n", stderr);
    int g = 1;
        for (int i=0; i < x; i++) {
        g = g * i;
    }
        return g;
}
int main() {
    printf("magic number %d\n", my_function(1));
    return 0;
}
```


## Using UPP

The `upp-transpile` utility is a handy way to see what upp macros have done to your code, however the main use-case for `upp` is as a wrapper for your C compiler of choice.

```bash
$ upp cc examples/trace.c
$ ./a.out
Entering my_function
magic number 0
```
All the command line options you specify are passed to the C compiler, making UPP an incredibly simple "drop-in" replacement for your C compiler: just prefix the compilation commands in your build system with "upp ". When `upp` is invoked like this, it find the .c files, and checks if there is a .cup file with the same name in the same directory. If there is, it will transpile the .cup file to a .c file, and then compile it with the C compiler, treating the resulting .c file as a build artifact. If there is not, it will just compile the .c file with the C compiler, assuming it's a source file. You build system will simply treat the generated .c files as your source, and continue as normal.

Typically, rather than define your macros in your C files, you'd put them in ".hup" files, and use `@include` to reference them.

## Testing with `upp --test`

UPP provides a unified test harness that can transpile, compile, and run your code in a single step. This is ideal for verification and regression testing.

```bash
$ upp --test examples/my_test.cup
```

The output will include the materialized C code, compilation status, and the standard output of the executed program. This is the mechanism used by the UPP test suite to manage snapshots.

The only built in macro is `@define`, even `@include` is implemented as a macro which you can find in `std/include.hup`.

This allows you to create powerful, reusable abstractions across your project.

UPP comes with a small standard set of macros in the `std/` directory. These are loaded by default when you run `upp-transpile`.

## "std" macros

By default, on "include.hup" is included. You can include more macros by using the `@include` macro in individual files, or by setting listing them in the upp.json for your project or directory.

Because the macros are defined in terms of the AST, you don't have to guess how these extended langauge features work. You can examine the implmentation and improve, modify or extend them to your needs. The only macro that you can't change the behaviour of is `@define` itself!

### `@include(path)`
Includes a .hup file, and generates the corresponding .h file for native C files.
- **Example**: `@include("my_macros.hup")`
- **File**: `std/include.h`

### `@method(Type)`
Enables C++ style method syntax for C structs.
- **Example**: `p.distance()` -> `_Point_method_distance(&p)`
- **File**: `std/method.h`

### `@defer code;`
Schedules a piece of code to run at the end of the current scope.
- **Example**: `char *ptr = malloc(10); @defer free(ptr);`
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

## upp.json

The upp.json file define where `upp` will look for your macros. By default, it contains

```json
{
    "comments": true, // Show what was replaced in a comment in the resulting .c file
    "includePaths": ["${UPP}/std"], // Paths to search for .hup files
    "core": ["include.hup"] // std macros to include by default
}
```

You can override these settings on a per-directory basis. The additional field "extends" is a relative path to another upp.json file which should be read in advance on which the current one will apply changes. Note that arrays are merged and de-duped.

## How to Write Macros

Macros are defined using the `@define` keyword. Within the definition body, you can write standard JavaScript. You are provided with:
1.  **Parameters**: Any arguments passed to the macro (e.g., `arg1`, `arg2`).
2.  **`upp`**: The magic helper object for navigating and manipulating the AST.
3.  **`console`**: Standard Node.js console for debugging.

A good place to start is to go to https://tree-sitter.github.io/tree-sitter/7-playground.html. This allows you to see how tree-sitter parses C code and the format of the trees it generates. The macro code will typically execute the logic required to transform one tree into another by cutting, pruning, moving and updating the nodes.

### Replacement vs. Consumption

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
-   `upp.createUniqueIdentifier(prefix)`: Generates a unique C-safe identifier.
-   `upp.childForFieldName(node, fieldName)`: Reliable way to access tree-sitter fields.


