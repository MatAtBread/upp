# "std" macros

By default, on "include.hup" is included. You can include more macros by using the `@include` macro in individual files, or by setting listing them in the upp.json for your project or directory.

Because the macros are defined in terms of the AST, you don't have to guess how these extended langauge features work. You can examine the implmentation and improve, modify or extend them to your needs. The only macro that you can't change the behaviour of is `@define` itself!

## `@include(path)`
Includes a .hup file, and generates the corresponding .h file for native C files.
- **Example**: `@include("my_macros.hup")`
- **File**: `std/include.h`

## `@method(Type)`
Enables C++ style method syntax for C structs.
- **Example**: `p.distance()` -> `_Point_method_distance(&p)`
- **File**: `std/method.h`

## `@defer code;`
Schedules a piece of code to run at the end of the current scope.
- **Example**: `char *ptr = malloc(10); @defer free(ptr);`
- **File**: `std/defer.h`

## `@async`
Simplifies asynchronous function calls.
- **Example**: `@async my_task();`
- **File**: `std/async.h`

## `@lambda`
Provides support for anonymous functions and closures in C. The macro will automatically capture all variables in the current scope that are used in the lambda.
- **Example**: `char *salutation = "Hello"; @lambda int greet(const char *name) { printf("%s %s\n", salutation, name); };`
- **File**: `std/lambda.h`

## `@trap(handler)`
Intercepts assignments to variables or struct fields and pipes them through a handler.
- **Example**: `@trap(log_change) int x;`
- **File**: `std/trap.h`

## `@fieldsof(Type)`
Implements basic structural inheritance by copying fields from one struct to another.
- **Example**: `struct Derived { @fieldsof(struct Base); int extra; };`
- **File**: `std/fieldsof.h`

## `@forward`
Automatically generates forward declarations for all functions in the current file.
- **File**: `std/forward.h`