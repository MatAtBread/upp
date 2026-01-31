@define inner(node) {
    return "expanded_inner;";
}

@define outer(node) {
    // Should expand @inner() immediately if we support nested expansion
    // OR should be caught in the next pass.
    return upp.code`@inner`;
}

int main() {
    @outer;
    return 0;
}
