#ifndef __UPP_STDLIB_LAMBDA_H__
#define __UPP_STDLIB_LAMBDA_H__

@define lambda() {
    // Manual find without consume/replace to preserve node stability for processReferences
    let fnNode = null;
    let anchor = upp.contextNode ? upp.contextNode : (upp.invocation ? upp.invocation.invocationNode : null);

    // If anchor is the function definition itself (contextNode logic)
    if (anchor && anchor.type === 'function_definition') {
        fnNode = anchor;
    } else if (anchor) {
        fnNode = upp.nextNamedSibling(anchor);
        while (fnNode && fnNode.type.includes('comment')) {
            fnNode = upp.nextNamedSibling(fnNode);
        }
    }

    if (!fnNode || fnNode.type !== 'function_definition') {
        upp.error(anchor, "lambda expected function_definition");
    }

    const fnDecl = upp.childForFieldName(fnNode, 'declarator'); // function_declarator
    const nameNode = upp.childForFieldName(fnDecl, 'declarator'); // function_declarator -> identifier
    const fnName = nameNode ? nameNode.text : "lambda_unknown";

    // Capture params early to avoid node invalidation issues
    const paramListNode = upp.childForFieldName(fnDecl, 'parameters');
    const paramsContent = paramListNode ? paramListNode.text : null;

    const bodyNode = upp.childForFieldName(fnNode, 'body');

    // Type extraction (fallback to 'void' if missing, usually fine)
    const typeNode = upp.childForFieldName(fnNode, 'type');
    let returnType = typeNode ? typeNode.text : "void";
    if (returnType === 'lambda' || returnType === 'lambda_unknown') {
         // Attempt to find real type (sibling of typeNode? or hardcode void)
         // Usually it's void for lambda.
         returnType = "void";
    }

    // Reconstruct function signature to include original parameters
    let paramsText = "";
    if (paramsContent && paramsContent.trim().length > 2) { // check if not empty parens ()
         const content = paramsContent.trim().slice(1, -1).trim(); // remove ()
         if (content.length > 0) {
             paramsText = ", " + content;
         }
    }

    // 1. Identify captures
    const captureMap = new Map(); // name -> defNode

    const fnStart = fnNode.startIndex;
    const fnEnd = fnNode.endIndex;
    const isInsideFn = (n) => n.startIndex >= fnStart && n.endIndex <= fnEnd;

    upp.walk(bodyNode, (node) => {
        if (node.type === 'identifier') {
            const def = upp.getDefinition(node);
            // Use range check instead of isDescendant
            if (def && !isInsideFn(def)) {
                 captureMap.set(node.text, def);
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
            if (def && !isInsideFn(def)) {
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


    const implCode = `\n${returnType} ${implName}(struct ${ctxName} *ctx${paramsText}) ${bodyText}\n`;

    upp.hoist("\n" + structDef + implCode);

    // 4. Replace Usage & Recursively Handle Aliases
    const contextArg = `(&ctx)`;
    const processedNodes = new Set();

    function processReferences(targetDefNode, isOriginal) {
        if (!targetDefNode || processedNodes.has(targetDefNode.id)) return;
        processedNodes.add(targetDefNode.id);

        upp.walk(upp.root, (ref) => {
            if (ref.type !== 'identifier') return;

            if (ref.text !== targetDefNode.text) {
                 return;
            }

            if (isOriginal && isInsideFn(ref)) {
                 return;
            }

            const refParent = upp.parent(ref);
            if (!refParent) return;

            // Usage Type 1: Function Call -> target(...)
            if (refParent.type === 'call_expression' && upp.childForFieldName(refParent, 'function') === ref) {
                 const call = refParent;
                 const args = upp.childForFieldName(call, 'arguments');
                 let newArgs = contextArg;
                 if (upp.childCount(args) > 2) {
                      const inner = args.text.slice(1, -1);
                      newArgs = `(${contextArg.slice(1, -1)}, ${inner})`;
                 }

                 const replacementName = isOriginal ? implName : ref.text;
                 upp.replace(call, `${replacementName}${newArgs}`);
                 return;
            }

            // Usage Type 2: Alias Initialization / Declaration
            if (refParent.type === 'init_declarator' && upp.childForFieldName(refParent, 'value') === ref) {
                 const initDecl = refParent;
                 const declStmt = upp.parent(initDecl);

                 const decl = upp.childForFieldName(initDecl, 'declarator');
                 let foundAlias = null;
                 upp.walk(decl, n => {
                     if (n.type === 'identifier' && !foundAlias) foundAlias = n;
                 });
                 let aliasId = foundAlias;

                 if (isOriginal && aliasId && declStmt && declStmt.type === 'declaration') {
                      let prefix = "";
                      for(let i=0; i<upp.childCount(declStmt); i++) {
                          const c = upp.child(declStmt, i);
                          if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') {
                              prefix += c.text + " ";
                          }
                      }

                      const newDecl = `${prefix}typeof(&${implName}) ${aliasId.text} = ${implName};`;
                      upp.replace(declStmt, newDecl);

                      if (aliasId) processReferences(aliasId, false);
                      return;
                 } else if (aliasId) {
                      processReferences(aliasId, false);
                 }
            }
            // Usage Type 3: Assignment -> z = hello;
            else if (refParent.type === 'assignment_expression' && upp.childForFieldName(refParent, 'right') === ref) {
                 const left = upp.childForFieldName(refParent, 'left');
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
        });
    }

    processReferences(nameNode, true);

    // 5. Replace Definition
    const captureList = Array.from(captureMap.keys());
    let initFields = captureList.map(name => `.${name} = &${name}`).join(', ');
    const initCode = `struct ${ctxName} ctx = { ${initFields} };`;

    upp.replace(fnNode, "");

    return initCode;
}

#endif
