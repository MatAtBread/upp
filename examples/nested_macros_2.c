@define inner() {
    return "expanded_inner";
}

@define outer() {
    return upp.code`@inner`;
}

int main() {
    @outer;
    return 0;
}
