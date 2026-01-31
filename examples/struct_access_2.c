@define method(node) {
    // In the scavenging pattern, @method treats the very next node
    // as the Struct Name, and the one after that as the Function.

    let structNameNode, funcDef;

    if (node.type === 'function_definition') {
        // If the parser synthesized Point int func() into a function_definition
        structNameNode = node.childForFieldName('type');
        funcDef = node; // The whole thing is the function
    } else {
        // Otherwise, we manually pluck them
        structNameNode = node;
        funcDef = node.nextNamedSibling;
    }

    const structName = structNameNode.text;
    const funcDeclarator = funcDef.childForFieldName('declarator');
    const funcIdentifier = funcDeclarator.childForFieldName('declarator');
    const originalName = funcIdentifier.text;
    const newName = `_${structName}_method_${originalName}`;

    // 1. We must "consume" the struct name from the output.
    if (node.type === 'function_definition') {
        // If it's a synthesis, we replace the "type" (Point) with empty string
        // but wait, we need the actual return type (int) to stay!
        // This is where scavenging gets tricky with a standard C parser.
        // For now, let's just replace the Point token range.
        upp.replace(structNameNode, "");
    } else {
        upp.replace(structNameNode, "");
    }

    // 2. Rename the function
    upp.replace(funcIdentifier, newName);

    // 3. Walk the tree to find references like p.distance()
    upp.walk(upp.root, (n) => {
        if (n.type === 'call_expression') {
            const fnNode = n.childForFieldName('function');
            if (fnNode && fnNode.type === 'field_expression') {
                const fieldName = fnNode.childForFieldName('field').text;
                if (fieldName === originalName) {
                    const objectNode = fnNode.childForFieldName('argument');
                    const argsNode = n.childForFieldName('arguments');
                    const operator = fnNode.child(1).text;
                    const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;
                    const argsList = argsNode.text.slice(1, -1);
                    const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');
                    upp.replace(n, upp.code`${newName}(${finalArgs})`);
                }
            }
        }
    });
}

struct Point {
    int x;
    int y;
};
typedef struct Point Point;

// No parentheses! Scavenging style.
@method Point int distance(Point *p) {
    return p->x * p->x + p->y * p->y;
}

int main() {
    Point p;
    int r = p.distance();
    return 0;
}
