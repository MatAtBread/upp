@define map(node) {
    let arrayNode, varNode, bodyNode;

    if (node.type === 'function_definition') {
        arrayNode = node.childForFieldName('type');
        varNode = node.childForFieldName('declarator');
        bodyNode = node.childForFieldName('body');
    } else {
        arrayNode = node;
        varNode = node.nextNamedSibling;
        bodyNode = varNode ? varNode.nextNamedSibling : null;
    }

    if (!bodyNode || (bodyNode.type !== 'compound_statement' && bodyNode.type !== 'ERROR')) {
        upp.error(node, `@map: Expected a block, but found ${bodyNode?.type}.`);
    }

    // Explicitly delete the extra nodes we've consumed
    if (node.type !== 'function_definition') {
        upp.replace(varNode, "");
        upp.replace(bodyNode, "");
    }

    const arrayName = arrayNode.text;
    const varName = varNode.text;
    const body = bodyNode.text;

    return upp.code`
    for (int _i = 0; _i < sizeof(${arrayName})/sizeof(${arrayName}[0]); _i++) {
        int ${varName} = ${arrayName}[_i];
        ${body}
        ${arrayName}[_i] = ${varName};
    }`;
}

int main() {
    int arr[] = {1, 2, 3};
    @map arr z { z = z + 1; };
    return 0;
}

