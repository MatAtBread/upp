#include <stdio.h>

@define lambda() {
    const fnNode = upp.consume('function_definition');
    const nameNode = fnNode.childForFieldName('declarator').childForFieldName('declarator'); // function_declarator -> identifier
    const fnName = nameNode.text;
    const bodyNode = fnNode.childForFieldName('body');

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
        let typeStr = upp.getType(def);
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
    const { returnType, params } = upp.getFunctionSignature(fnNode);
    let paramsText = "";
    if (params && params.trim().length > 2) { // check if not empty parens ()
         const content = params.trim().slice(1, -1).trim(); // remove ()
         if (content.length > 0) {
             paramsText = ", " + content;
         }
    }

    // Note: getFunctionSignature params returns "(int a)" including parens.
    // Logic above handles stripping parens and appending.

    const implCode = `\n${returnType} ${implName}(struct ${ctxName} *ctx${paramsText}) ${bodyText}\n`;

    upp.hoist("\n" + structDef + implCode);

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