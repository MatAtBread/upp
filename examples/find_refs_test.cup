@define rename(newName) {
    const node = upp.contextNode;
    // We expect the macro to be applied to an identifier (declaration)
    const refs = upp.findReferences(node);
    for (const ref of refs) {
        upp.replace(ref, newName);
    }
}

@rename(y)
int x = 10;

void print_x() {
    printf("Global x: %d\n", x);
}

int main() {
    print_x();
    x = 20;
    print_x();
    return 0;
}
