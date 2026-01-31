@define test_error_type() {
    const node = upp.consume('compound_statement');
    return node.text;
}

@define test_error_message() {
    const node = upp.consume({
        type: 'compound_statement',
        message: 'Custom error: @test_error_message needs a { block }'
    });
    return node.text;
}

@define test_error_missing() {
    const node = upp.consume('compound_statement');
    return node.text;
}

int main() {
    // 1. Wrong type (expression instead of block)
    // @test_error_type printf("Hello\n");

    // 2. Custom error message
    // @test_error_message int x = 0;

    // 3. Missing node at end of file
    // @test_error_missing

    return 0;
}

@test_error_missing
