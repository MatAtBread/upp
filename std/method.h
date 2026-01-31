#ifndef __UPP_STDLIB_METHOD_H__
#define __UPP_STDLIB_METHOD_H__

@define method(targetType) {
    const node = upp.consume();
    // Re-parse for stability (workaround for tree-sitter instability)
    let funcDef = node;
    try {
        if (upp.parseFragment) {
            const freshRoot = upp.parseFragment(node.text);
            if (freshRoot && freshRoot.childCount > 0) {
                funcDef = freshRoot.child(0);
            }
        }
    } catch (e) {}


    let isExternDecl = false;
    // node is typically the consumed node. If it's a type (void), we might be in a declaration.
    if (node.type === 'primitive_type' || node.type === 'type_identifier' || node.type === 'struct_specifier' || node.type === 'enum_specifier') {
        const parent = upp.parent(node);
        if (parent && parent.type === 'declaration') {
             isExternDecl = true;
             funcDef = parent;
        }
    }

    const funcDeclarator = upp.childForFieldName(funcDef, 'declarator');

    // Handle potential pointer declarators
    let funcDecl = funcDeclarator;
    while (funcDecl && funcDecl.type === 'pointer_declarator') {
        funcDecl = upp.childForFieldName(funcDecl, 'declarator');
    }

    const funcIdentifier = upp.childForFieldName(funcDecl, 'declarator');
    if (!funcIdentifier) return;

    const originalName = funcIdentifier.text;

    // Check for infinite loop / recursion
    if (originalName.startsWith('_') && originalName.includes('_method_')) {
         return isExternDecl ? node.text : node.text;
    }

    // 1. Sanitize targetType to handle "struct Point" vs "Point"
    let cleanTarget = targetType.trim();
    if (cleanTarget.startsWith('struct ')) {
        cleanTarget = cleanTarget.slice(7).trim();
    }

    // 2. Generate new name: _Point_method_distance
    const newName = `_${cleanTarget}_method_${originalName}`;

    let outputText = "";

    // 3. Rename
    if (isExternDecl) {
        // Transform the DECLARATOR only (disjoint from macro).
        // Return the consumed type node text (to restore the hole we made).
        let declaratorText = funcDeclarator.text;
        const startOffset = funcIdentifier.startIndex - funcDeclarator.startIndex;
        const endOffset = funcIdentifier.endIndex - funcDeclarator.startIndex;
        const newDeclaratorText = declaratorText.slice(0, startOffset) + newName + declaratorText.slice(endOffset);

        upp.replace(funcDeclarator, newDeclaratorText);
        outputText = node.text;
    } else {
        // Standard Definition Renaming
        let functionText = node.text;
        const idStart = (funcIdentifier.tree === node.tree) ? (funcIdentifier.startIndex - node.startIndex) : funcIdentifier.startIndex;
        const idEnd = (funcIdentifier.tree === node.tree) ? (funcIdentifier.endIndex - node.startIndex) : funcIdentifier.endIndex;
        functionText = functionText.slice(0, idStart) + newName + functionText.slice(idEnd);
        outputText = functionText;
    }

    // 4. Register global transformer for method calls
    upp.registerTransform((root, helpers) => {
        // Find global references via Query (bypasses finding all references, targets only calls)
        const callMatches = helpers.query(`(call_expression function: (field_expression field: (field_identifier) @method))`, root);

        for (const match of callMatches) {
            const methodNode = match.captures.method;
            if (methodNode.text !== originalName) continue;

            // Traverse up to find field_expression and call_expression from the capture
            const fnNode = helpers.parent(methodNode);
            if (!fnNode || fnNode.type !== 'field_expression') continue;

            const callNode = helpers.parent(fnNode);
            if (!callNode || callNode.type !== 'call_expression') continue;

            // CHECK FOR CONFLICTS WITH EXISTING REPLACEMENTS (e.g. Defer deletion)
            // Note: replacements is global for the registry in helpers
            const isConflict = helpers.registry.helpers.replacements.some(r => {
                return (r.start < callNode.endIndex && r.end > callNode.startIndex);
            });
            if (isConflict) continue;

            const objectNode = helpers.childForFieldName(fnNode, 'argument');
            const argsNode = helpers.childForFieldName(callNode, 'arguments');
            const operator = helpers.child(fnNode, 1).text; // . or ->

            // 5. Type Validation
            const objDef = helpers.getDefinition(objectNode);

            if (objDef) {
                let objType = helpers.getType(objDef);

                // FALLBACK FOR VOID/BROKEN TYPES
                if (objType.includes('void')) {
                        const varName = objectNode.text;
                        try {
                            const declMatches = helpers.query(`
                                (declaration
                                    type: (_) @type
                                    declarator: [(init_declarator declarator: (identifier) @id) (identifier) @id]
                                )
                            `, root);
                            for (const m of declMatches) {
                                if (m.captures.id.text === varName) {
                                    objType = m.captures.type.text;
                                    break;
                                }
                            }
                        } catch (e) {}
                }

                // Cleanup type string
                let cleanObjType = objType.replace(/\*/g, '').replace(/struct /g, '').trim();
                let targetAlias = cleanTarget;

                // Try to resolve typedef if mismatch
                if (cleanObjType !== cleanTarget) {
                    try {
                            const tdMatches = helpers.query(`(type_definition) @td`, root);
                            for (const m of tdMatches) {
                                const td = m.captures.td;
                                const typeNode = helpers.childForFieldName(td, 'type');
                                const nameNode = helpers.childForFieldName(td, 'declarator');

                                if (!typeNode || !nameNode) continue;

                                const nameText = nameNode.text;
                                const typeText = typeNode.text.replace(/struct /g, '').trim();

                                if (nameText === cleanTarget) {
                                    targetAlias = typeText;
                                    break;
                                }
                                if (nameText === cleanObjType) {
                                    cleanObjType = typeText;
                                }
                            }
                    } catch(e) {}
                }

                if (cleanObjType === cleanTarget || cleanObjType === targetAlias) {
                    const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;
                    const argsList = argsNode.text.slice(1, -1);
                    const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');

                    helpers.replace(callNode, helpers.code`${newName}(${finalArgs})`);
                }
            } else {
                // Fallback to name-only match
                const objRef = operator === '.' ? `&(${objectNode.text})` : objectNode.text;
                const argsList = argsNode.text.slice(1, -1);
                const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');
                helpers.replace(callNode, helpers.code`${newName}(${finalArgs})`);
            }
        }
    });

    // 6. Special Handling for Defer
    if (!isExternDecl) {
        if (originalName === 'Defer') {
            const matches = upp.query(`(declaration type: (type_identifier) @type) @decl`);
            for (const m of matches) {
                if (m.captures.type.text === cleanTarget) {
                    const declNode = m.captures.decl;
                    // Find variable name in declaration
                    // Handle: Type var; and Type var = val;
                    let varName = null;

                    // Simple case: Type var;
                    for (let i = 0; i < declNode.childCount; i++) {
                         const child = declNode.child(i);
                         if (child.type === 'identifier') {
                             varName = child.text;
                             break;
                         }
                    }

                    // Complex case: Type var = val; (init_declarator)
                    if (!varName) {
                        const init = upp.childForFieldName(declNode, 'declarator'); // field: declarator?
                        // Actually declaration children are not always fields.
                        const initDecl = upp.query(`(init_declarator declarator: (identifier) @id)`, declNode);
                        if (initDecl.length > 0) {
                            varName = initDecl[0].captures.id.text;
                        }
                    }

                    if (varName) {
                        upp.replace({ start: declNode.endIndex, end: declNode.endIndex }, upp.code` @defer ${varName}.Defer();`);
                    }
                }
            }
        }
    } // End of !isExternDecl

    return outputText;

}

@define useCreate(T) {
    let node = upp.consume();
    let name, init;
    const text = node.text.trim();

    if (node.type === 'type_identifier' || node.type === 'identifier') {
        name = text;
        init = "= {0}";
        // Optional: consume the trailing semicolon if it exists to avoid ;;
        if (node.nextSibling && node.nextSibling.type === ';') {
            upp.replace(node.nextSibling, "");
        }
    } else {
        const match = text.match(/^(\w+)\s*=\s*(.*);?$/);
        name = match[1];
        init = ' = ' + match[2].replace(/;$/, '');
    }

    // Check for renamed symbol in the AST
    const renamedSymbol = `_${T}_method_Create`;
    const hasCreate = upp.query(`
        (function_definition
            declarator: (function_declarator
                declarator: (identifier) @name))
    `, upp.root).some(m => m.captures.name.text === renamedSymbol);

    if (hasCreate) {
        upp.replace({start: node.endIndex, end: node.endIndex}, ` ${name}.Create();`);
    }

    return upp.code`${T} ${name} ${init};`;
}

#endif
