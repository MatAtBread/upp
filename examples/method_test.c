@define method(targetType) {
    const node = upp.contextNode;
    const funcDef = node;
    const funcDeclarator = funcDef.childForFieldName('declarator');
    const funcIdentifier = funcDeclarator.childForFieldName('declarator');
    const originalName = funcIdentifier.text;

    // Sanitize targetType to handle "struct Point" vs "Point"
    let cleanName = targetType.trim();
    if (cleanName.startsWith('struct ')) {
        cleanName = cleanName.slice(7).trim();
    }

    // Generate new name: _Point_method_distance
    const newName = `_${cleanName}_method_${originalName}`;

    // Rename function
    upp.replace(funcIdentifier, newName);

    // Find references: p.distance()
    upp.walk(upp.root, (n) => {
        if (n.type === 'call_expression') {
            const fnNode = n.childForFieldName('function');
            if (fnNode && fnNode.type === 'field_expression') {
                const fieldName = fnNode.childForFieldName('field').text;
                if (fieldName === originalName) {
                    const objectNode = fnNode.childForFieldName('argument');
                    const argsNode = n.childForFieldName('arguments');

                    // Simple type check inference?
                    // Ideally we should check if objectNode's type matches 'targetType',
                    // but for this example we'll blindly match method name.
                    // (Real implementation would use upp.getType(objectNode) logic)

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

#include <stdio.h>

struct Base {
    int x;
};

typedef struct Base BaseTypedef;

typedef struct {
    int y;
} Unique;

// 1. method(struct Tag)
@method(struct Base) int getX(struct Base *b) {
    return b->x;
}

// 2. method(Typedef)
@method(BaseTypedef) void setX(BaseTypedef *b, int v) {
    b->x = v;
}

// 3. method(UniqueTypedef)
@method(Unique) int getY(Unique *u) {
    return u->y;
}

int main() {
    struct Base b = { 10 };
    BaseTypedef bt = { 20 };
    Unique u = { 100 };

    // Usage 1
    int val1 = b.getX();

    // Usage 2
    bt.setX(50);
    int val2 = bt.getX();

    // Usage 3
    int val3 = u.getY();

    printf("val1: %d\n", val1);
    printf("val2: %d\n", val2);
    printf("val3: %d\n", val3);

    return 0;
}
