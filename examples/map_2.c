@define map(node,arrayName,varName) {
    let bodyNode;

    console.log(node.type);
    if (node.type !== 'compound_statement') {
        upp.error(node, `@map: Expected a block, but found ${node?.type}.`);
    }

    return upp.code`
    for (int _i = 0; _i < sizeof(${arrayName})/sizeof(${arrayName}[0]); _i++) {
        int ${varName} = ${arrayName}[_i];
        ${node}
        ${arrayName}[_i] = ${varName};
    }`;
}

int main() {
    int arr[] = {1, 2, 3};
    @map(arr, z) { z = z + 1; };
    return 0;
}

