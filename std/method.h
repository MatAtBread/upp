#ifndef __UPP_STDLIB_METHOD_H__
#define __UPP_STDLIB_METHOD_H__

@define method(targetType) {
    const node = upp.contextNode;
    const funcDef = node;
    const funcDeclarator = funcDef.childForFieldName('declarator');

    // Handle potential pointer declarators
    let funcDecl = funcDeclarator;
    while (funcDecl && funcDecl.type === 'pointer_declarator') {
        funcDecl = funcDecl.childForFieldName('declarator');
    }

    const funcIdentifier = funcDecl.childForFieldName('declarator');
    if (!funcIdentifier) return; // Should not happen in valid C

    const originalName = funcIdentifier.text;

    // 1. Sanitize targetType to handle "struct Point" vs "Point"
    let cleanTarget = targetType.trim();
    if (cleanTarget.startsWith('struct ')) {
        cleanTarget = cleanTarget.slice(7).trim();
    }

    // 2. Generate new name: _Point_method_distance
    const newName = `_${cleanTarget}_method_${originalName}`;

    // 3. Rename function definition
    upp.replace(funcIdentifier, newName);

    // 4. Find references: p.distance()
    const refs = upp.findReferences(funcIdentifier);
    for (const ref of refs) {
        if (ref === funcIdentifier) continue;

        // Verify it's a call like obj.method() or obj->method()
        const fnNode = ref.parent;
        if (fnNode && fnNode.type === 'field_expression') {
            const callNode = fnNode.parent;
            if (callNode && callNode.type === 'call_expression') {
                const objectNode = fnNode.childForFieldName('argument');
                const argsNode = callNode.childForFieldName('arguments');
                const operator = fnNode.child(1).text; // . or ->

                // 5. Type Validation
                const objDef = upp.getDefinition(objectNode);
                if (objDef) {
                    let objType = upp.getType(objDef);
                    // Remove pointers and struct tags for comparison
                    let cleanObjType = objType.replace(/\*/g, '').replace(/struct /g, '').trim();

                    if (cleanObjType === cleanTarget) {
                        const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;
                        const argsList = argsNode.text.slice(1, -1);
                        const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');

                        upp.replace(callNode, upp.code`${newName}(${finalArgs})`);
                    }
                } else {
                    // Fallback to name-only match if type can't be resolved (less robust but better than nothing)
                    // This often happens for complex expressions that aren't direct variable refs
                    const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;
                    const argsList = argsNode.text.slice(1, -1);
                    const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');
                    upp.replace(callNode, upp.code`${newName}(${finalArgs})`);
                }
            }
        }
    }
}

#endif
