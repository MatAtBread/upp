@define stringify(...parts) {
    return `"${parts.join(' ')}"`;
}

int main() {
    const char *s = @stringify(Hello, World, from, UPP);
    return 0;
}

