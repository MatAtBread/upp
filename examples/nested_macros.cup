static int expanded_inner = 1;
@define inner() {
    return "expanded_inner;";
}

@define outer() {
    // Should expand @inner() immediately if we support nested expansion
    // OR should be caught in the next pass.
    return upp.code`@inner`;
}

int main() {
    @outer;
    return 0;
}
