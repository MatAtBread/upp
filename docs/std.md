# Standard Macro Library

UPP comes with a powerful set of standard macros in the `std/` directory. These macros demonstrate how to extend C with modern features like closures, deferred execution, and structural inheritance.

## `@async`
Simplifies the creation and management of asynchronous tasks. (See [std/async.hup](../std/async.hup)).

- **Usage**: `@async function_definition() { body }`
- **Example**:
  ```c
  @async void fetch_data(const char *url) {
      // Asynchronous code here
  }
  ```
> **Note**: This macro is currently a placeholder. The exact implementation is subject to change.

## `@defer`
Schedules a piece of code to run automatically at the end of the current scope. It intelligently handles multiple `return` statements by injecting the deferred code before each return.

- **Usage**: `@defer { code_block }` or `@defer expression_statement;`
- **Example**:
  ```c
  FILE *f = fopen("log.txt", "w");
  @defer fclose(f);
  
  if (error) return -1; // fclose(f) is called here
  return 0; // and here
  ```
- **Definition**: [std/defer.hup](../std/defer.hup)

## `@expressionType`
Performs compile-time analysis to determine the C type of an expression. It evaluates literals, function return types, and variable declarations.

- **Usage**: `@expressionType(expression)`
- **Example**:
  ```c
  const char *type = @expressionType(1.0 + 2); // returns "double"
  ```
- **Definition**: [std/expressionType.hup](../std/expressionType.hup)

## `@fieldsof`
Implements basic structural composition by copying fields from one struct/typedef into another. This allows for a form of inheritance or shared state between structs.

- **Usage**: `@fieldsof(struct_name)` or `@fieldsof(typedef_name)`
- **Example**:
  ```c
  struct Base { int x, y; };
  struct Derived {
      @fieldsof(struct Base);
      int z;
  };
  ```
- **Definition**: [std/fieldsof.hup](../std/fieldsof.hup)

## `@forward`
Automatically scans the current file and generates forward declarations (prototypes) for all non-static functions. useful for avoiding "implicit declaration" warnings without manual header maintenance.

- **Usage**: Place `@forward` at the top of your file.
- **Definition**: [std/forward.hup](../std/forward.hup)

## `@lambda`
Provides anonymous functions and closures. It automatically captures local variables used inside the body and manages the necessary context structures and hoisting.

- **Usage**: `@lambda return_type name(params) { body }`
- **Example**:
  ```c
  int offset = 10;
  @lambda int add_offset(int x) { return x + offset; };
  printf("%d\n", add_offset(5)); // Outputs 15
  ```
- **Definition**: [std/lambda.hup](../std/lambda.hup)

## `@method`
Enables "Object-Oriented" style syntax for C structs. It renames function definitions and transforms `object.method()` calls into standard C function calls.

- **Usage**: `@method(TypeName) return_type method_name(params) { body }`
- **Example**:
  ```c
  struct Point { int x, y; };
  
  @method(struct Point) void print(struct Point *self) {
      printf("%d, %d\n", self->x, self->y); 
  }
  
  struct Point p = {1, 2};
  p.print(); // Transpiles to _Point_method_print(&p)
  ```
- **Definition**: [std/method.hup](../std/method.hup)

## `@package` & `@implements`
Provides a module system for C. `@package` defines a public interface, prefixing symbols with the package name to avoid collisions. `@implements` flags a file as the authoritative implementation of a package.

- **Usage**: 
  - In `pkg.hup`: `@package(pkgName)`
  - In `pkg.cup`: `@implements(pkgName)`
- **Definition**: [std/package.hup](../std/package.hup)

## `@trap`
Intercepts assignments to a variable or struct field and routes the new value through a handler function.

- **Usage**: `@trap(handler_name) type variable_name;`
- **Example**:
  ```c
  int log_val(int v) { printf("Setting to %d\n", v); return v; }
  
  @trap(log_val) int x = 0;
  x = 10; // Outputs: Setting to 10
  ```
- **Definition**: [std/trap.hup](../std/trap.hup)