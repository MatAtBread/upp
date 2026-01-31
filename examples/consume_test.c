@define test_validate() {
    const node = upp.consume({
        type: 'expression_statement',
        validate: (n) => n.text.includes('VALID'),
        message: '@test_validate requires an expression containing "VALID"'
    });
    return node.text;
}

@define test_valid() {
    // 1. Basic consume with type string
    const block1 = upp.consume('compound_statement');

    // 2. Consume skipping comments
    const block2 = upp.consume('compound_statement');

    // 3. Consume with multiple types
    const stmt = upp.consume(['expression_statement', 'declaration']);

    return upp.code`
    // Valid cases
    {
        ${block1}
        ${block2}
        ${stmt}
    }`;
}

int main() {
    @test_valid
    {
        printf("Block 1\n");
    }
    // Comment between blocks
    {
        printf("Block 2\n");
    }
    int x = 10;

    return 0;
}
