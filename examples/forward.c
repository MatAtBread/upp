@define forward() {
    // Scan for all function definitions in the file
    const root = upp.root;
    let forwardDecls = "";

    for (let i = 0; i < root.childCount; i++) {
        const node = root.child(i);
        if (node.type === 'function_definition') {
             // Extract signature
             const { returnType, name, params } = upp.getFunctionSignature(node);

             // Skip main function if desired, though technically legal to forward declare
             if (name === 'main') continue;

             forwardDecls += `${returnType} ${name}${params};\n`;
        }
    }

    if (forwardDecls.length > 0) {
        upp.hoist(forwardDecls);
    }

    // The macro call itself @forward; consumes the statement?
    // upp.consume calls? No, if we don't consume anything, we just replace the invocation.

    // If usage is "@forward;" which is an expression_statement (identifier aka macro invocation)
    // The registry logic: invocation replacement content.
    // We can return "" to remove the @forward line.
    return "";
}

@forward;

void foo() {
    printf("Foo calls bar\n");
    bar();
}

void bar() {
    printf("Bar called\n");
}

int main() {
    foo();
    return 0;
}
