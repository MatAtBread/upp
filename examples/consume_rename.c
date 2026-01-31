@define rename_context(newName) {
    const node = upp.contextNode;
    // 1. In-place edit preference
    // upp.contextNode leaves the node in the source.
    // We only need to find references and rename them.
    // The declaration itself is also a reference (if it's an identifier).

    const refs = upp.findReferences(node);
    for (const ref of refs) {
        upp.replace(ref, newName);
    }
}

@define rename_consume(newName) {
    // 1. Consume removes the node from the source output
    const node = upp.consume('declaration');

    // 2. Find internal identifier to get the original name
    const declarator = node.childForFieldName('declarator');
    const identifier = declarator.childForFieldName('declarator');
    const originalName = identifier.text;

    // 3. Find external references
    // Note: findReferences works on the current tree state.
    const refs = upp.findReferences(identifier);
    for (const ref of refs) {
        // Only replace references that are NOT inside the consumed node.
        // If we replace inside the consumed node, it's wasted because
        // the node is already removed from output!
        // (Or worse, could cause conflicts if we return the original text).

        // Use a simple containment check (this works because refs are nodes)
        const isInternal = (ref.startIndex >= node.startIndex && ref.endIndex <= node.endIndex);

        if (!isInternal) {
            upp.replace(ref, newName);
        }
    }

    // 4. Return the modified text for the consumed node
    // Since we consumed it, WE are responsible for outputting it back.
    // We can't use upp.replace() on it directly because its text is purely our return value now.

    // We manually replace the name in the original text.
    // (Be careful with simple string replace if the name appears elsewhere in the line)
    return node.text.replace(originalName, newName);
}

// 1. Using context (Safe, recommended for refactoring)
@rename_context(y_ctx)
int x_ctx = 10;

void test_ctx() {
    x_ctx = 20;
}

// 2. Using consume (Requires manual reconstruction)
@rename_consume(y_cons)
int x_cons = 100;

void test_cons() {
    x_cons = 200;
}

int main() {
    return 0;
}
