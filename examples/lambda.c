#include <stdio.h>

@define lambda() {
    const fnNode = upp.consume('function_definition');
    const nameNode = fnNode.childForFieldName('declarator').childForFieldName('declarator'); // function_declarator -> identifier
    const fnName = nameNode.text;
    const bodyNode = fnNode.childForFieldName('body');

    // Helper to extract type string from a definition identifier
    function getType(defNode) {
        let decl = defNode.parent;
        let suffix = "";

        while (decl) {
             if (decl.type === 'pointer_declarator') {
                 suffix = "*" + suffix;
             }
             if (decl.type === 'array_declarator') {
                 suffix = "[]" + suffix;
             }

             if (decl.type === 'declaration' || decl.type === 'parameter_declaration') {
                 break;
             }
             decl = decl.parent;
        }

        if (!decl) return "void *"; // fallback

        let prefix = "";
        for (let i = 0; i < decl.childCount; i++) {
             const c = decl.child(i);
             if (c.type === 'type_qualifier' || c.type === 'storage_class_specifier') {
                  prefix += c.text + " ";
             }
        }

        const typeNode = decl.childForFieldName('type');
        let typeText = typeNode ? typeNode.text : "void";

        return (prefix + typeText + " " + suffix).trim();
    }

    // 1. Identify captures
    const captureMap = new Map(); // name -> defNode

    upp.walk(bodyNode, (node) => {
        if (node.type === 'identifier') {
            const def = upp.getDefinition(node);
            if (def && !upp.isDescendant(fnNode, def)) {
                 captureMap.set(def.text, def);
            }
        }
    });

    // 2. Generate Context Struct
    const ctxName = upp.createUniqueIdentifier('lambda_ctx');

    let structFields = "";
    for (const [name, def] of captureMap) {
        let typeStr = getType(def);
        structFields += `    ${typeStr} *${name};\n`;
    }

    const structDef = `struct ${ctxName} {\n${structFields}\n};\n`;

    // 3. Generate Hoisted Implementation
    const implName = upp.createUniqueIdentifier(`${fnName}_impl`);

    const hoistReplacements = [];
    upp.walk(bodyNode, (node) => {
        if (node.type === 'identifier' && captureMap.has(node.text)) {
            const def = upp.getDefinition(node);
            if (def && !upp.isDescendant(fnNode, def)) {
                 hoistReplacements.push({
                     start: node.startIndex,
                     end: node.endIndex,
                     text: `(*ctx->${node.text})`
                 });
            }
        }
    });

    hoistReplacements.sort((a, b) => b.start - a.start);

    let bodyText = bodyNode.text;
    const bodyStart = bodyNode.startIndex;

    for (const r of hoistReplacements) {
        const relStart = r.start - bodyStart;
        const relEnd = r.end - bodyStart;
        bodyText = bodyText.slice(0, relStart) + r.text + bodyText.slice(relEnd);
    }

    // Reconstruct function signature to include original parameters
    const declarator = fnNode.childForFieldName('declarator');
    // declarator is a function_declarator. Its 'parameters' child is parameter_list.
    // If complex (pointer declarator etc), we might need to dig, but simple case:
    const paramList = declarator.childForFieldName('parameters');
    let paramsText = "";
    if (paramList) {
         // paramList.text is "(int a, float b)"
         const content = paramList.text.slice(1, -1).trim();
         if (content.length > 0) {
             paramsText = ", " + content;
         }
    }

    const retType = fnNode.childForFieldName('type').text;
    const implCode = `\n${retType} ${implName}(struct ${ctxName} *ctx${paramsText}) ${bodyText}\n`;

    // Hoist after includes/defines to ensure visibility
    let hoistIndex = 0;
    const root = fnNode.tree.rootNode;

    for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i);
        if (child.type === 'comment' || child.type.startsWith('preproc_')) {
             if (child.endIndex > hoistIndex) {
                 hoistIndex = child.endIndex;
             }
        } else if (child.type.trim() === '' || child.type === 'ERROR') {
             // skip
        } else {
             if (child.startIndex > hoistIndex) break;
        }
    }

    upp.replace({start: hoistIndex, end: hoistIndex}, "\n" + structDef + implCode);

    // 4. Replace Usage & Recursively Handle Aliases
    const contextArg = `(&ctx)`;
    const processedNodes = new Set();

    function processReferences(targetDefNode, isOriginal) {
        if (!targetDefNode || processedNodes.has(targetDefNode.id)) return;
        processedNodes.add(targetDefNode.id);

        const references = upp.findReferences(targetDefNode);

        for (const ref of references) {
            if (isOriginal && upp.isDescendant(fnNode, ref)) continue;

            // Usage Type 1: Function Call -> target(...)
            if (ref.parent.type === 'call_expression' && ref.parent.childForFieldName('function') === ref) {
                 const call = ref.parent;
                 const args = call.childForFieldName('arguments');
                 let newArgs = contextArg;
                 if (args.childCount > 2) {
                      const inner = args.text.slice(1, -1);
                      newArgs = `(${contextArg.slice(1, -1)}, ${inner})`;
                 }

                 const replacementName = isOriginal ? implName : ref.text;
                 upp.replace(call, `${replacementName}${newArgs}`);
                 continue;
            }

            // Usage Type 2: Alias Initialization / Declaration
            if (ref.parent.type === 'init_declarator' && ref.parent.childForFieldName('value') === ref) {
                 const initDecl = ref.parent;
                 const declStmt = initDecl.parent;

                 const decl = initDecl.childForFieldName('declarator');
                 let foundAlias = null;
                 upp.walk(decl, n => {
                     if (n.type === 'identifier' && !foundAlias) foundAlias = n;
                 });
                 let aliasId = foundAlias;

                 if (isOriginal && aliasId && declStmt.type === 'declaration') {
                      let prefix = "";
                      for(let i=0; i<declStmt.childCount; i++) {
                          const c = declStmt.child(i);
                          if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') {
                              prefix += c.text + " ";
                          }
                      }

                      const newDecl = `${prefix}typeof(&${implName}) ${aliasId.text} = ${implName};`;
                      upp.replace(declStmt, newDecl);

                      if (aliasId) processReferences(aliasId, false);
                      continue;
                 } else if (aliasId) {
                      processReferences(aliasId, false);
                 }
            }
            // Usage Type 3: Assignment -> z = hello;
            else if (ref.parent.type === 'assignment_expression' && ref.parent.childForFieldName('right') === ref) {
                 const left = ref.parent.childForFieldName('left');
                 let aliasId = null;
                 if (left.type === 'identifier') aliasId = left;

                 if (isOriginal) {
                    upp.replace(ref, implName);
                 }

                 if (aliasId) {
                     let def = upp.getDefinition(aliasId);
                     if (def) processReferences(def, false);
                 }
            }
            else if (isOriginal) {
                upp.replace(ref, implName);
            }
        }
    }

    processReferences(nameNode, true);

    // 5. Replace Definition
    const captureList = Array.from(captureMap.keys());
    let initFields = captureList.map(name => `.${name} = &${name}`).join(', ');
    const initCode = `struct ${ctxName} ctx = { ${initFields} };`;
    return initCode;
}

int main() {
    char *name = "Diego";
    int direction = 1;
    @lambda void hello(int num) {
        const char *salutation = direction ? "Hello" : "Bye";
        printf("%s %s %d\n", salutation, name, num);
    }

    hello(1);
    name = "Fabio";
    hello(2);
    direction = 0;
    hello(3 );

    const (void (*z)(int)) = hello;
    z(4);

    return 0;
}