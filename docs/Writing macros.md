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
* `${modifiers.wrap("new_x")}` yields `new_x`.

**This completely eliminates the need for you to write manual string inspection logic to handle `*` or `[]` within your macros.**

---

## 4. Referential Stability via Template Tags

Always use the `$``...`` ` or `upp.code``...`` ` template tag when generating replacement code.

Behind the scenes, this isn't just generating strings. It is actively reconstructing an AST. When you interpolate a captured node (like `${x}`), UPP fundamentally *moves* that object reference into the new tree structure.

This ensures **referential stability**. If another macro requested to track references to `x` via `upp.withReferences(x)`, that tracker will survive the transformation. If you mistakenly used standard JS string templates (`` `...${x.text}...` ``), the tree reference is destroyed, and the tracking macro will fail to locate the new string.
