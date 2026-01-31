@define myMacro(a, b) {
    return upp.code`/* ${a}, ${b} */`;
}

@define transformer(node, x) {
    upp.replace(node, upp.code`/* ${x} */ ${node.text}`);
}

int main() {
    // Correct
    @myMacro(1, 2)
    @transformer(10) int a;

    // Error: Too few
    @myMacro(1)

    // Error: Too many
    @myMacro(1, 2, 3)

    // Error: Transformer with wrong count
    @transformer int b;
    @transformer(1, 2) int c;

    return 0;
}
