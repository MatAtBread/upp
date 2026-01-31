@define stringify(node, str) {
    return `"${str}"`;
}

int main() {
    const char *s = @stringify(hello);
    return 0;
}

