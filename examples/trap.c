@define trap(arg) {
    const declNode = upp.consume(['declaration', 'field_declaration'], 'expected a variable or field declaration');

    // Determine declared identifier
    let varName = "";
    let varIdNode = null;

    // Use recursive walk to find the identifier being declared
    // For 'declaration', it's usually inside 'init_declarator' or 'declarator'
    // For 'field_declaration', it's inside 'field_declarator' (or just 'identifier' / 'array_declarator')
    upp.walk(declNode, n => {
        if (!varName && (n.type === 'identifier' || n.type === 'field_identifier')) {
            // We need to ensure we aren't picking up a type name or something else.
            // Check if it's the declared name.
            if (upp.isDescendant(declNode, n)) {
                 // Double check context:
                 // declaration -> init_declarator -> declarator -> identifier
                 // field_declaration -> field_declarator -> field_identifier
                 // Also handle pointers: pointer_declarator -> ...

                 // Heuristic: if parent is a declarator type or the node itself is a field_identifier
                 if (n.parent.type.includes('declarator') || n.type === 'field_identifier') {
                     varName = n.text;
                     varIdNode = n;
                 }
            }
        }
    });

    if (!varName) {
        upp.error(declNode, "Could not find declared identifier for @trap");
    }

    // Determine Handler Name
    let handlerName = "";

    // Check if argument is a Code Block (starts with {) or Identifier
    // arg is a string.
    const trimmedArg = arg.trim();

    if (trimmedArg.startsWith('{')) {
        // Case: @trap({ val + 1 })
        // Generate wrapper
        const typeStr = upp.getType(varIdNode);
        handlerName = upp.createUniqueIdentifier(`${varName}_trap`);
        const bodyText = trimmedArg;
        const handlerCode = `${typeStr} ${handlerName}(${typeStr} value) ${bodyText}`;
        upp.hoist(handlerCode);
    } else {
        // Case: @trap(my_handler)
        // Verify it looks like an identifier
        if (/^[a-zA-Z_]\w*$/.test(trimmedArg)) {
             handlerName = trimmedArg;
        } else {
             // We can't use upp.error with a string effectively without context.
             // We can use declNode for context error
             upp.error(declNode, `@trap argument '${trimmedArg}' must be a code block or function identifier`);
        }
    }

    // Transform Assignments
    // We find references to varIdNode.
    const refs = upp.findReferences(varIdNode);
    for (const ref of refs) {
        if (upp.isDescendant(declNode, ref)) continue;

        // Usage: z = expr OR obj.z = expr
        // assignment_expression(left: field_expression(argument: identifier, field: field_identifier)) ??

        let assignment = ref.parent;
        // Check if ref is part of the LEFT side of assignment
        // Simple case: z = ... (parent is assignment, left is ref)
        // Struct case: obj.z = ... (parent is field_expression, parent.parent is assignment, left is field_expression)

        // Traverse up to find assignment
        while (assignment && assignment.type !== 'assignment_expression') {
            assignment = assignment.parent;
            // Stop if we hit a statement boundary or something indicating we aren't in an assignment l-value
            if (assignment && (assignment.type === 'expression_statement' || assignment.type === 'compound_statement')) {
                assignment = null;
                break;
            }
        }

        if (assignment && assignment.type === 'assignment_expression') {
            const left = assignment.childForFieldName('left');
            // Check if our ref is indeed part of the 'left' side
            if (upp.isDescendant(left, ref)) {
                 const right = assignment.childForFieldName('right');
                 const rightText = right.text;
                 upp.replace(right, `${handlerName}(${rightText})`);
            }
        }
    }

    // Reconstruct Declaration with Init (only for standard declarations, fields can't have init in C (mostly))
    if (declNode.type === 'declaration') {
        const initDecl = declNode.childForFieldName('declarator'); // init_declarator
        let newDeclText = declNode.text;

        if (initDecl && initDecl.type === 'init_declarator') {
             const val = initDecl.childForFieldName('value');
             if (val) {
                 const relStart = val.startIndex - declNode.startIndex;
                 const relEnd = val.endIndex - declNode.startIndex;

                 newDeclText = newDeclText.slice(0, relStart) +
                               `${handlerName}(${val.text})` +
                               newDeclText.slice(relEnd);
             }
        }
        return newDeclText;
    }

    return declNode.text; // For fields, return as is (they don't support init values in C89/99 usually, or if they do (C++11), logic handles it?)
}

int my_logger(int v) {
    printf("Logging value: %d\n", v);
    return v;
}

struct Point {
    @trap({ return value * 2; }) int x;
    @trap(my_logger) int y;
};

int main() {
    struct Point p;
    p.x = 10; // x = trap(10) -> 20
    p.y = 5;  // y = logger(5) -> 5, prints "Logging value: 5"

    @trap({ return value + 1; }) int z = 10; // z = trap(10) -> 11
    z = 20; // z = trap(20) -> 21

    printf("p.x=%d, p.y=%d, z=%d\n", p.x, p.y, z);
    return 0;
}
