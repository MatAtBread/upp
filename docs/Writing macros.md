# Writing Macros in UPP

UPP is designed to let you manipulate C code seamlessly without needing to manually traverse or reconstruct complex Abstract Syntax Trees (ASTs) by hand. Instead, it relies on **structural pattern matching**.

This guide covers the nuances of writing effective, elegant macros using UPP's pattern matcher and template generators.

---

## 1. The Core Mechanic: Match & Replace

Most macros in UPP follow a simple sequence:
1. **Target**: Identify the code you want to transform (e.g. by intercepting the macro call via `upp.consume()`, or by running a global query using `upp.withMatch()`).
2. **Deconstruct**: Parse the target AST into labeled variables using a structural pattern string.
3. **Reconstruct**: Generate the replacement C code by interpolating those labeled variables back into a template string using the `$` alias (or `upp.code`).

### Simple Example:

```c
// Target: Replace `swap(a, b);` with an inline XOR swap
upp.withMatch(
    upp.root, 
    "swap($x, $y);", 
    ({x, y}) => $`{ ${x}^=${y}; ${y}^=${x}; ${x}^=${y}; }`
)
```

Notice that we never called `.child(0)` or `.type === 'identifier'`. The pattern `"swap($x, $y);"` instructs UPP to structurally find exactly that shape in the C tree and yield the inner variable nodes to our callback.

## 2. Structural Patterns vs. Regex

It is critical to understand that UPP's matcher **is not a text-based regex matcher**. It parses your pattern string into a Tree-sitter AST, and then structurally compares that AST against the target C code.

This guarantees immense safety:
* `"$type $name = $val;"` will correctly match `int x = 5;` and `unsigned long int count = 0;`.
* It will **not** match `if (type == val)`. (Regex might accidentally snag this!).
* It perfectly ignores whitespace and comments! `int    x =  5;` is structurally identical to `int x=5;`.

### Constraints

You can annotate capture names with constraints or restrict structural rules. Following a capture name with a double underscore (`__`) introduces a constraint. By default, the constraints are AST node types, so for example: 

```c
if ($cond) $statement__compound_statement
```
...will only match `if` statements that have a compound statement body. 

A more complex case could be as follows. This transform only matches where variables are added or subtracted from constants, each with a different mapping.

```c
@define A() {
    const node = upp.nextNode();
    upp.withMatch(node, 
        "$x + $y__number_literal", 
        ({ x, y }) => `0 /* WAS: ${x.text} + ${y.text} */`
    );
    upp.withMatch(node, 
        "$x - $y__number_literal", 
        ({ x, y }) => `99 /* WAS: ${x.text} - ${y.text} */`
    );
    return null;
}

@A int main() { 
    int foo = 100;
    int bar = 200;
    int z = foo + 1;
    int w = foo + bar;
    int x = foo - bar;
    int y = foo - 1;
    printf("%d %d\n", z, w);
    return 0; 
}
```

The output of which is:

```c
 int main() {
    int foo = 100;
    int bar = 200;
    int z = 0 /* WAS: foo + 1 */;
    int w = foo + bar;
    int x = foo - bar;
    int y = 99 /* WAS: foo - 1 */;
    printf("%d %d\n", z, w);
    return 0;
}
```

The above example shows the general pattern of writing macros: find patterns and re-write them using UPP to modify and manipulate the AST.

### Wildcard Suffixes

You can annotate wildcards to loosen or restrict structural rules:

* **`__until`**: Greedily matches multiple sibling nodes up to the next pattern delimiter.
  * Example: `$returnType $name($args__until) { $body__until }`
  * This matches an entire function definition, capturing the entire parameter list into `args` and every statement in the block into `body`.
* **`__NOT_` Constraint**: Rejects matches if the captured node is of a specific type.
  * Example: `if ($cond) $statement__NOT_compound_statement;`
  * This specifically targets single-line `if` statements that lack `{}` braces.

---

## 3. The Elegance of Wrapped Identifiers (Pointers & Arrays)

One of the most powerful features of UPP's pattern matcher is how it handles language-specific identifier wrappers, like C pointers (`*x`) and arrays (`x[]`).

In C, the grammar enforces that identifiers can never sit adjacently without punctuation. For example, `int x y;` is invalid C. 

Because of this rigid grammatical law, **UPP treats contiguous wildcards as an implicit optional-wrapper capture**.

### Using `$modifiers$name`

If you want to match a variable declaration, but need to elegantly handle pointers or arrays effortlessly, you write:

```javascript
"$type $modifiers$name"
```

If the target C code is `int *fn[];`:
1. UPP dynamically peels off the `*` and `[]` wrappers.
2. It assigns `fn` to `$name`.
3. It bundles the `*` and `[]` wrappers into a synthetic object assigned to `$modifiers`.

### Reconstructing the Identifier

What makes this so powerful is how seamlessly it generates code using JS templates.

The `$modifiers` object is "smart". 
* If you interpolate it blindly (e.g. `${modifiers}`), it natively reconstructs the original wrapped text.
* If you invoke `.for(newName)` on it, it dynamically wraps your *new* identifier in the exact same pointers or arrays mathematically.

```javascript
({type, modifiers, name}) => [
    // If target was: int *x[];
    
    $`${type} ${modifiers};`,
    // Emits: int *x[];
    // (Notice we didn't even need to include ${name}!)
    
    $`${type} ${modifiers.for("new_" + name.text)};` 
    // Emits: int *new_x[];
]

```

What happens if the target was just a simple `int x;`?
* UPP still satisfies the pattern!
* `${modifiers}` simply yields `x`.
* `${modifiers.for("new_x")}` yields `new_x`.
* Calling `${modifiers.for()}` without arguments defaults to the original wrapped target's text.

**This completely eliminates the need for you to write manual string inspection logic to handle `*` or `[]` within your macros.**

---

## 4. Referential Stability via Template Tags

Always use the `$``...`` ` or `upp.code``...`` ` template tag when generating replacement code.

Behind the scenes, this isn't just generating strings. It is actively reconstructing an AST. When you interpolate a captured node (like `${x}`), UPP fundamentally *moves* that object reference into the new tree structure.

This ensures **referential stability**. If another macro requested to track references to `x` via `upp.withReferences(x)`, that tracker will survive the transformation. If you mistakenly used standard JS string templates (`` `...${x.text}...` ``), the tree reference is destroyed, and the tracking macro might fail to locate the new string.

---

# Reference: UPP Helpers API

The `upp` object provides a rich set of utilities for inspecting and modifying source code within UPP macros and transformation rules.

## 1. Source Generation & Modification

### `upp.code`
Tagged template literal for generating source fragments. Crucially, it **moves** interpolated nodes rather than converting them to strings, maintaining their referential identity for other macros.

- **Signature**: `upp.code\`strings: TemplateStringsArray, ...values: InterpolationValue[]\`` -> `SourceNode`
- **Alias**: `$` — available as a shorthand in all macro bodies (e.g., `$\`int ${x} = 0;\``)
- **Example**:
  ```javascript
  const newNode = upp.code`int ${name}_v2 = ${value};`;
  // Equivalent using the shorthand:
  const newNode = $`int ${name}_v2 = ${value};`;
  ```

### `upp.replace`
Replaces a node with new content. Returns an empty string, making it convenient for use inside `upp.code` templates to perform side-effect replacements without adding text. 
**Note:** `upp.replace` is only for use on *immediate/child* nodes relative to the current context. For replacing nodes *outside* the current `contextNode` (remote modification), the preferred pattern is `upp.withNode()`. Using `upp.replace` on remote nodes is likely to the walker will not run any rules (including macros) on the replacement node.

- **Signature**: `upp.replace(node: SourceNode, content: MacroResult)` -> `SourceNode | SourceNode[] | null`
- **Example**:
  ```javascript
  upp.code`${upp.replace(oldNode, newNode)}`;
  ```

### `upp.insertAfter` and `upp.insertBefore`
Inserts a node before or after an existing node. These mark the parent node for re-visiting via `upp.revisit()`. This ensures that the newly inserted nodes are visible to the walker and get subject to rule processing correctly. This makes them significantly safer than manual tree splicing, which runs the risk of bypassing rule evaluation altogether (unless specifically intended, which itself can be problematic).

- **Signature**: `upp.insertAfter(node: SourceNode, content: MacroResult)` -> `void`
- **Signature**: `upp.insertBefore(node: SourceNode, content: MacroResult)` -> `void`

### `upp.consume`
Removes the next logical node from the source tree if it matches the specified types.

- **Signature**: `upp.consume(types: string | string[], [message: string])` -> `SourceNode | SourceNode[] | string | string[] | null`
- **Example**:
  ```javascript
  const fn = upp.consume('function_definition');
  ```

### `upp.nextNode`
Peeks at the next logical node without removing it from the tree.

- **Signature**: `upp.nextNode(types?: string | string[])` -> `SourceNode | null`

---

## 2. Structural Pattern Matching

Patterns use structural matching (not just regex). 
- Use `$name` to capture a node.
- Use `__until` (e.g., `$args__until`) to capture multiple nodes.
- Use constraints (e.g., `$id__identifier__type_identifier`) to restrict node types.

### `upp.match`
Performs a one-off match against a specific node.

- **Signature**: `upp.match(node: SourceNode, pattern: string, [callback], [options])` -> `CaptureResult | null`
- **Options**: `{ deep?: boolean }` (default `false`). If `true`, the pattern matcher searches recursively down the node's descendants. If `false`, it only matches precisely at the given node.
- **Example**:
  ```javascript
  upp.match(node, "int $name = $val;", ({ name, val }) => {
      console.log(`Variable ${name.text} set to ${val.text}`);
  });
  ```

### `upp.matchAll`
Finds all structural matches of a pattern within a scope.

- **Signature**: `upp.matchAll(node: SourceNode, pattern: string, options?: { deep?: boolean })` -> `Array<{ node, captures }>`
- **Options**: `{ deep?: boolean }`. Defaults to `true` if the node is a `translation_unit` (root), otherwise `false`. Allows finding nested matches.

---

## 3. Deferred Transformations (The `withX` Pattern)

All deferred transformation APIs register a `PendingRule` in the unified rule system. Rules are evaluated both during the depth-first walk and during the final fixed-point sweep.

### `upp.withMatch`
Registers a deferred transformation for nodes matching a structural pattern within a scope. This is the **recommended** approach for pattern-based global transforms.

- **Signature**: `upp.withMatch(scope: SourceNode, pattern: string, callback, options?: { deep?: boolean })` -> `void`
- **Options**: `{ deep?: boolean }`. Controls whether the pattern matcher recurses deeply into descendants of `scope`. Defaults to `false` unless `scope` is the root `translation_unit`.
- **Example**:
  ```javascript
  // Transform all brace-less if statements:
  upp.withMatch(upp.root, "if ($cond) $then__NOT_compound_statement;",
      ({ cond, then }) => upp.code`if (${cond}) { ${then} }`);
  ```

### `upp.withPattern`
Registers a transformation for a specific AST node type (e.g., `call_expression`, `return_statement`), filtered by a custom matcher function. Use when you need lower-level control than `withMatch` provides.

Unlike `matchAll`, `withPattern` does not take a `deep` option because the deferred rule automatically evaluates against every node in the AST as the walker ascends.

- **Signature**: `upp.withPattern(type: string, matcher, callback)` -> `void`
- **Example**:
  ```javascript
  // Transform method-style calls: obj.method(args) -> _Type_method(&obj, args)
  upp.withPattern('call_expression',
      (node, h) => node.named['function']?.type === 'field_expression',
      (node, h) => { /* transform logic */ });
  ```

### `upp.withNode`
Attaches a one-off deferred transformation to a specific node.

- **Signature**: `upp.withNode(node: SourceNode, callback)` -> `void`

### `upp.withRoot`
Registers a callback to be invoked on the root node during the final sweep. Useful for imperative operations like hoisting code.

- **Signature**: `upp.withRoot(callback)` -> `void`

### `upp.withScope`
Registers a callback to be invoked on a specific scope node.

- **Signature**: `upp.withScope(scope: SourceNode, callback)` -> `void`

---

## 4. Tree Queries & Navigation

- **`upp.root`**: The root node of the current tree.
- **`upp.findScope(node?)`**: Finds the nearest enclosing scope (e.g., `{}` block or function).
- **`upp.findEnclosing(node, types)`**: Finds the nearest ancestor of the given type(s).
- **`upp.findInvocations(macroName)`**: Finds all calls to a specific macro.

---

## 5. C-Specific Helpers (`UppHelpersC`)

These helpers are available when the language is set to C.

### `upp.getType`
Extracts the C type specification for a node or expression. It performs comprehensive type resolution, handling declarations, pointers, arrays, function calls, arithmetic operations, and literals.

- **Signature**: `upp.getType(node: SourceNode | string, options?: { resolve?: boolean }) -> string | SourceNode | null`
- **Resolution Mechanism**: 
  - **Input Parsing**: If a `string` is passed, UPP interprets it as an identifier and looks up its definition first (`upp.findDefinitionOrNull`). If a `SourceNode` is passed, it is evaluated directly.
  - **Expression Evaluation**: Recursively evaluates the type of complex expressions (e.g., `a + b`, `*ptr`, `arr[0]`, `func()`) by analyzing their operators and operand types.
  - **`{ resolve: true }`**: When enabled, if the type resolves to a struct, union, or enum, `getType` attempts to return the actual `SourceNode` defining the type (the `struct_specifier` block) rather than just its string representation. This allows macros to inspect the fields of the resolved type natively.

### `upp.withExpressionType`
Registers a deferred rule to transform any expression within a scope that mathematically evaluates to a specific C type.

- **Signature**: `upp.withExpressionType(scope: SourceNode, target: SourceNode | string, callback: (node, helpers) => string | null)` -> `void`
- **Mechanism**: The `target` type is dynamically evaluated once upon registration (using `getType({resolve: true})`). The internal walker then matches any expression descendant of `scope` whose evaluated type precisely equals the target type—whether it's a primitive type like `"int"`, or a complex struct node reference.
- **Example**:
  ```javascript
  // Replace any expression evaluating to 'double' with a macro call
  upp.withExpressionType(upp.root, "double", (node) => {
      return \`DOUBLE_VAL(\${node.text})\`;
  });
  ```

### `upp.getFunctionSignature`
Extracts details from a `function_definition` node.

- **Signature**: `upp.getFunctionSignature(fnNode: SourceNode)` -> `{ name, returnType, params, bodyNode, nameNode }`

### `upp.getArrayDepth`
Returns the number of array dimensions wrapping an identifier (e.g., `int x[10][20]` returns 2).

- **Signature**: `upp.getArrayDepth(defNode: SourceNode)` -> `number`

### `upp.findDefinition`
Resolves an identifier or name to its declaration node.

- **Signature**: `upp.findDefinition(target: SourceNode | string, [nameOrOptions], [options])` -> `SourceNode`

### `upp.findReferences`
Finds all semantic references to a declaration node.

- **Signature**: `upp.findReferences(defNode: SourceNode)` -> `SourceNode[]`

### `upp.withReferences`
Intelligently transforms all references to a specific definition, accurately finding references across the AST without premature node removal (ensuring the context of the reference remains valid when the rule fires).

- **Signature**: `upp.withReferences(defNode: SourceNode, callback)` -> `void`

### `upp.hoist`
Prepends code to the top of the file (typically after includes).

- **Signature**: `upp.hoist(content: string)` -> `void`

---

## 6. Infrastructure

- **`upp.createUniqueIdentifier(prefix?)`**: Generates a guaranteed-unique C identifier.
- **`upp.loadDependency(file)`**: Loads another file to make its macros and symbols available.
- **`upp.callMacro(name, ...args)`**: Calls another macro programmatically by name, executing it in the current context. Useful for composing macros.
- **`upp.walk(node, callback)`**: Manually walk the AST.
- **`upp.isDescendant(parent, node)`**: Returns true if `node` is a descendant of `parent`.
- **`upp.invocation`**: Metadata about the current macro call (args, file, line, etc.).
- **`upp.registry`**: Direct access to the internal macro registry.
