/*
NB: this macro impl doesn't work. It frees "nested" long after the scope has gone.
 */
@define defer(node) {
    const fn = upp.findEnclosing(node, 'function_definition');
    if (!fn) upp.error(node, "@defer must be within a function");

    // Initialize registry tracking for this function
    const fnId = fn.id;
    if (!upp.registry.deferData) upp.registry.deferData = {};
    if (!upp.registry.deferData[fnId]) {
        const declarator = fn.childForFieldName('declarator');
        const fnName = upp.query('(identifier) @id', declarator)[0].captures.id.text;
        const returnType = fn.childForFieldName('type').text;

        upp.registry.deferData[fnId] = {
            name: fnName,
            returnType: returnType,
            returnVarName: upp.createUniqueIdentifier('ret'),
            labelPrefix: upp.createUniqueIdentifier(`return_${fnName}`),
            blocks: [], // { text: string, pos: number, id: number }
            applied: false
        };

        // Register a global transform to handle this function's boilerplate
        upp.registerTransform((root, helpers) => {
            const data = upp.registry.deferData[fnId];
            if (data.applied) return;

            // Find the specific function body
            const matches = helpers.query(`
                (function_definition
                    declarator: (function_declarator declarator: (identifier) @id)
                    body: (compound_statement) @body)
            `, root);

            let targetBody = null;
            for (const m of matches) {
                if (m.captures.id.text === data.name) {
                    targetBody = m.captures.body;
                    break;
                }
            }
            if (!targetBody) return;

            const isVoid = data.returnType === 'void';

            // 1. Declare return variable at the top of the body
            if (!isVoid) {
               const insertPos = targetBody.startIndex + 1;
               helpers.replace({start: insertPos, end: insertPos}, helpers.code` \n    ${data.returnType} ${data.returnVarName};`);
            }

            // 2. Replace all returns in this body
            const returns = helpers.query('(return_statement) @ret', targetBody);
            const sortedBlocks = data.blocks.slice().sort((a, b) => a.pos - b.pos);

            for (const r of returns) {
                const retNode = r.captures.ret;

                // Find all defers that were encountered BEFORE this return
                const activeDefers = sortedBlocks.filter(b => b.pos < retNode.startIndex);

                if (activeDefers.length === 0) continue;

                const labelId = activeDefers.length - 1;
                const expr = retNode.child(1);

                if (!isVoid && expr && expr.text !== ';') {
                    helpers.replace(retNode, helpers.code`{ ${data.returnVarName} = ${expr.text}; goto ${data.labelPrefix}_${labelId}; }`);
                } else {
                    helpers.replace(retNode, helpers.code`goto ${data.labelPrefix}_${labelId};`);
                }
            }

            // 3. Append labels and cleanup at the end
            let cleanup = "";
            for (let i = sortedBlocks.length - 1; i >= 0; i--) {
                cleanup += `${data.labelPrefix}_${i}:\n  ${sortedBlocks[i].text}\n`;
            }

            if (isVoid) {
                cleanup += `  return;\n`;
            } else {
                cleanup += `  return ${data.returnVarName};\n`;
            }

            const lastBrace = targetBody.endIndex - 1;
            helpers.replace({start: lastBrace, end: lastBrace}, helpers.code`\n${cleanup}`);

            data.applied = true;
        });
    }

    upp.registry.deferData[fnId].blocks.push({
        text: node.text,
        pos: node.startIndex
    });
    return "";
}

int main() {
    char *str1 = malloc(100);
    @defer { free(str1); str1 = NULL; }
    char *str2;

    {
        char *nested = malloc(100);
        @defer { free(nested); nested = NULL; }
        if (some_condition) {
            // should defer here, str1
            return 1;
        }
    }
    str2 = malloc(100);
    @defer { free(str2); str2 = NULL; }

    // should defer here, str2 then str1
    return 0;
}
