@define task(node) {
    let call = (node.type === 'expression_statement') ? node.child(0) : node;
    if (call.type !== 'call_expression') {
        upp.error(node, "@task must be applied to a function call");
    }
    const name = call.childForFieldName('function').text;
    return upp.code`os_start(${name});`;
}

@define async(node) {
    let def = (node.type === 'expression_statement' || node.type === 'declaration') ? node.child(0) : node;
    // Note: function_definition is usually top-level, but check anyway
    if (node.type !== 'function_definition') {
        upp.error(node, "@async must be applied to a function definition");
    }
    let name = "";
    // Save the range of the definition to avoid self-transforming the declarator
    const defStart = node.startIndex;
    const defEnd = node.endIndex;

    const declarator = node.childForFieldName('declarator');
    // Find the identifier within the potentially complex declarator
    const idMatches = upp.query(`(identifier) @id`, declarator);
    if (idMatches.length > 0) {
        name = idMatches[0].captures.id.text;
    }

    // Find all references to this function in the WHOLE tree
    if (name) {
        upp.registerTransform((root, helpers) => {
            const matches = helpers.query(`(call_expression function: (identifier) @id) @call`, root);
            for (const m of matches) {
                if (m.captures.id.text === name) {
                    const callNode = m.captures.call;
                    // Skip if this "call" is actually the function's own declarator
                    const parentType = callNode.parent ? callNode.parent.type : '';
                    if (parentType === 'function_declarator') continue;

                    // Double check: if it overlaps with the definition site, verify it's a real sub-call
                    // In a healthy parse, a call_expression should not be the declarator anyway.
                    helpers.replace(callNode, helpers.code`os_start(${name})`);
                }
            }
        });
    }

    return undefined; // Do not modify the target node (the definition)
}
