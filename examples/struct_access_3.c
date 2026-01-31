@define method(structName) {
    const node = upp.contextNode;
    // 1. Get the function definition following the macro
    const funcDef = node;
    const funcDeclarator = funcDef.childForFieldName('declarator');
    const funcIdentifier = funcDeclarator.childForFieldName('declarator');
    const originalName = funcIdentifier.text;
    const newName = `_${structName}_method_${originalName}`;

    // 2. Replace the function name in the definition
    upp.replace(funcIdentifier, newName);

    // 3. Use findReferences instead of manual walk
    const refs = upp.findReferences(funcIdentifier);
    for (const ref of refs) {
        if (ref === funcIdentifier) continue;

        // Verify it's a call like p.distance() or p->distance()
        const fnNode = ref.parent;
        if (fnNode && fnNode.type === 'field_expression') {
            const callNode = fnNode.parent;
            if (callNode && callNode.type === 'call_expression') {
                const objectNode = fnNode.childForFieldName('argument');
                const argsNode = callNode.childForFieldName('arguments');
                const operator = fnNode.child(1).text; // . or ->
                const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;

                const argsList = argsNode.text.slice(1, -1);
                const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');

                upp.replace(callNode, upp.code`${newName}(${finalArgs})`);
            }
        }
    }
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
    p.x = 10;
    p.y = 20;
    int r = p.distance();
    return 0;
}
