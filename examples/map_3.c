@define map(node, arrayName, varName) {
    const evenBlock = node;
    const oddBlock = upp.consume('compound_statement');

    if (!oddBlock || oddBlock.type !== 'compound_statement') {
        upp.error(node, "@map requires an even { block } and an odd { block }");
    }

    return upp.code`
    for (int _i = 0; _i < sizeof(${arrayName})/sizeof(${arrayName}[0]); _i++) {
        int ${varName} = ${arrayName}[_i];
        if (_i % 2 == 0) {
            ${evenBlock}
        } else {
            ${oddBlock}
        }
        ${arrayName}[_i] = ${varName};
    }`;
}

int main() {
    int arr[] = {1, 2, 3, 4};
    @map(arr, z) { z = z + 10; } { z = z + 100; };
    return 0;
}
