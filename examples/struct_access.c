@define method(node, structName) {
    // 1. Get the function definition following the macro
    // node is an expression_statement if it's outside main, but usually it's a function_definition here
    const funcDef = node;
    const funcDeclarator = funcDef.childForFieldName('declarator');
    const funcIdentifier = funcDeclarator.childForFieldName('declarator');
    const originalName = funcIdentifier.text;
    const newName = `_${structName}_method_${originalName}`;

    // 2. Replace the function name in the definition
    upp.replace(funcIdentifier, newName);

    // 3. Walk the tree to find references like p.distance()
    upp.walk(upp.root, (n) => {
        // Look for call_expression like p.distance()
        if (n.type === 'call_expression') {
            const fnNode = n.childForFieldName('function');
            if (fnNode && fnNode.type === 'field_expression') {
                const fieldName = fnNode.childForFieldName('field').text;
                if (fieldName === originalName) {
                    const objectNode = fnNode.childForFieldName('argument');
                    const argsNode = n.childForFieldName('arguments');

                    // Transformation: p.distance() -> _Point_method_distance(&p)
                    // (Simplified: we use & for dot access and assume pointer if it's ->)
                    const operator = fnNode.child(1).text; // . or ->
                    const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;

                    // Replace the whole call expression
                    // Use arguments without the parentheses
                    const argsList = argsNode.text.slice(1, -1);
                    const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');

                    upp.replace(n, upp.code`${newName}(${finalArgs})`);
                }
            }
        }
    });

    // We don't return anything as we are using upp.replace for surgical edits
}

struct Point {
    int x;
    int y;
};

@method(Point) int distance(Point *p) {
    return p->x * p->x + p->y * p->y;
}

int main() {
    Point p;
    int r = p.distance();
    return 0;
}
