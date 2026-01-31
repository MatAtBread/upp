static int expanded_inner;

@define inner() {
    return "expanded_inner";
}

@define outer() {
    return upp.code`${upp.consume()}`;
}

int main() {
    @outer @inner;
    return 0;
}
