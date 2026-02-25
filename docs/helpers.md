# UPP Helpers API Documentation

The `upp` object provides a rich set of utilities for inspecting and modifying source code within UPP macros and transformation rules.

## 1. Source Generation & Modification

### `upp.code`
Tagged template literal for generating source fragments. Crucially, it **moves** interpolated nodes rather than converting them to strings, maintaining their referential identity for other macros.

- **Signature**: `upp.code`strings: TemplateStringsArray, ...values: InterpolationValue[]` -> `SourceNode`
- **Alias**: `$` — available as a shorthand in all macro bodies (e.g., `$`int ${x} = 0;``)
- **Example**:
  ```javascript
  const newNode = upp.code`int ${name}_v2 = ${value};`;
  // Equivalent using the shorthand:
  const newNode = $`int ${name}_v2 = ${value};`;
  ```

### `upp.replace`
Replaces a node with new content. Returns an empty string, making it convenient for use inside `upp.code` templates to perform side-effect replacements without adding text.

- **Signature**: `upp.replace(node: SourceNode, content: MacroResult)` -> `SourceNode | SourceNode[] | null`
- **Example**:
  ```javascript
  upp.code`${upp.replace(oldNode, newNode)}`;
  ```

### `upp.consume`
Removes the next logical node from the source tree if it matches the specified types.

- **Signature**: `upp.consume(types: string | string[], [message: string])` -> `SourceNode | null`
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

- **Signature**: `upp.match(node: SourceNode, pattern: string, [callback])` -> `CaptureResult | null`
- **Example**:
  ```javascript
  upp.match(node, "int $name = $val;", ({ name, val }) => {
      console.log(`Variable ${name.text} set to ${val.text}`);
  });
  ```

### `upp.matchAll`
Finds all structural matches of a pattern within a scope.

- **Signature**: `upp.matchAll(node: SourceNode, pattern: string, options?: { deep: boolean })` -> `Array<{ node, captures }>`

### `upp.matchReplace`
Synchronously replaces all matches of a pattern within a scope during macro execution.

- **Signature**: `upp.matchReplace(scope: SourceNode, pattern: string, callback)` -> `void`

---

## 3. Deferred Transformations (The `withX` Pattern)

These methods register "markers" or "rules". Transformations are deferred and managed by the UPP engine to ensure they happen in the correct order, especially when moving nodes.

### `upp.withMatch`
Registers a deferred transformation for nodes matching a pattern within a scope.

- **Signature**: `upp.withMatch(scope: SourceNode, pattern: string, callback)` -> `void`
- **Example**:
  ```javascript
  upp.withMatch(upp.root, "$x + 0", ({ x }, upp2) => x);
  ```

### `upp.withPattern`
Registers a transformation for a specific node type, filtered by an optional matcher function.

- **Signature**: `upp.withPattern(type: string, matcher, callback)` -> `void`

### `upp.withNode`
Attaches a one-off deferred transformation to a specific node.

- **Signature**: `upp.withNode(node: SourceNode, callback)` -> `void`

---

## 4. Tree Queries & Navigation

- **`upp.root`**: The root node of the current tree.
- **`upp.findRoot()`**: Returns the root node (convenience).
- **`upp.findScope(node?)`**: Finds the nearest enclosing scope (e.g., `{}` block or function).
- **`upp.findEnclosing(node, types)`**: Finds the nearest ancestor of the given type(s).
- **`upp.findInvocations(macroName)`**: Finds all calls to a specific macro.

---

## 5. C-Specific Helpers (`UppHelpersC`)

These helpers are available when the language is set to C.

### `upp.getType`
Extracts the C type string for a definition node (handles pointers, arrays, etc.).

- **Signature**: `upp.getType(node: SourceNode | string)` -> `string`

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
Intelligently transforms all references to a specific definition, even if they are generated later.

- **Signature**: `upp.withReferences(defNode: SourceNode, callback)` -> `void`

### `upp.hoist`
Prepends code to the top of the file (typically after includes).

- **Signature**: `upp.hoist(content: string)` -> `void`

---

## 6. Infrastructure

- **`upp.createUniqueIdentifier(prefix?)`**: Generates a guaranteed-unique C identifier.
- **`upp.loadDependency(file)`**: Loads another file to make its macros and symbols available.
- **`upp.walk(node, callback)`**: Manually walk the AST.
- **`upp.isDescendant(parent, node)`**: Returns true if `node` is a descendant of `parent`.
- **`upp.invocation`**: Metadata about the current macro call (args, file, line, etc.).
- **`upp.registry`**: Direct access to the internal macro registry.
