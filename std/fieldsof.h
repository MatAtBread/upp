#ifndef __UPP_STDLIB_FIELDSOF_H__
#define __UPP_STDLIB_FIELDSOF_H__

@define fieldsof(targetStruct) {
    // 1. Validate Context
    // We expect the macro to be inside a struct definition, i.e., parent should be field_declaration_list
    // The contextNode might be the ERROR node or a placeholder node.
    let ctx = upp.contextNode;
    // Walk up to find field_declaration_list
    while (ctx && ctx.type !== 'field_declaration_list' && ctx.type !== 'translation_unit') {
        ctx = ctx.parent;
    }

    if (!ctx || ctx.type !== 'field_declaration_list') {
        upp.error(upp.helpers.invocation.invocationNode, "@fieldsof must be used inside a struct definition");
    }

    // 1b. Consume Trailing Semicolon
    // If the user wrote @fieldsof(...); we want to eat that semicolon so we don't end up with ;;
    const inv = upp.invocation;
    const source = upp.registry.sourceCode;
    let end = inv.endIndex;

    // Skip whitespace
    while (end < source.length && /\s/.test(source[end])) {
        end++;
    }

    if (source[end] === ';') {
        inv.endIndex = end + 1;
    }

    // 2. Resolve Target Type
    // targetStruct is like "struct Base", "Base", or "GeoCoord"
    let targetName = targetStruct.trim();
    let isStructTag = false;
    if (targetName.startsWith('struct ')) {
        targetName = targetName.substring(7).trim();
        isStructTag = true;
    }

    let structDef = null;
    const root = upp.root;

    upp.walk(root, (node) => {
        if (structDef) return;

        // Option A: struct Tag { ... }
        if (node.type === 'struct_specifier') {
             const nameNode = node.childForFieldName('name');
             // If we are looking for "struct Base", we match name "Base"
             // If we are looking for typedef "GeoCoord", this likely won't match unless it is "struct GeoCoord"
             if (isStructTag && nameNode && nameNode.text === targetName) {
                 structDef = node;
             }
             // Handle case where typedef matches struct tag? "typedef struct A A;"
             else if (!isStructTag && nameNode && nameNode.text === targetName) {
                 structDef = node;
             }
        }

        // Option B: typedef struct { ... } Name;
        if (!isStructTag && node.type === 'type_definition') {
             const declarator = node.childForFieldName('declarator');
             // type_definition -> type(struct_specifier), declarator(type_identifier)
             if (declarator && declarator.text === targetName) {
                 const typeNode = node.childForFieldName('type');
                 if (typeNode && typeNode.type === 'struct_specifier') {
                     structDef = typeNode;
                 }
             }
        }
    });

    if (!structDef) {
        upp.error(upp.helpers.invocation.invocationNode, `Could not find definition for struct/type ${targetName}`);
        return;
    }

    const fieldList = structDef.childForFieldName('body');
    if (!fieldList) {
        return "";
    }

    let fields = "";
    for (let i = 0; i < fieldList.childCount; i++) {
        const child = fieldList.child(i);
        if (child.type === 'field_declaration') {
            fields += child.text + "\n    ";
        }
    }

    return fields;
}

#endif
