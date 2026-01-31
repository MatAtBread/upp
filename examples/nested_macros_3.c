@define inner(node) {
    return "expanded_inner";
}

@define outer(node) {
    return upp.code`@inner`;
}

int main() {
    @outer;
    return 0;
}
