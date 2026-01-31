@define defer() {
    const node = upp.consume('compound_statement');
    const scope = upp.findEnclosing(node, 'compound_statement');
    if (!scope) return;

    // 1. Check for forbidden flow control anywhere in the scope
    upp.walk(scope, (n) => {
        if (['break_statement', 'continue_statement', 'goto_statement'].includes(n.type)) {
            throw new Error(`@defer cannot be used in a scope containing ${n.type.replace('_statement', '')}`);
        }
    });

    // 2. Insert before all subsequent return statements
    upp.walk(scope, (n) => {
        if (n.type === 'return_statement' && n.startIndex > node.startIndex) {
            upp.replace({ start: n.startIndex, end: n.startIndex }, upp.code`${node.text} `);
        }
    });

    // 3. Insert before the block's closing brace, but only if the last statement isn't a return
    const lastStmt = scope.lastNamedChild;
    if (lastStmt && lastStmt.type !== 'return_statement') {
        const endBrace = scope.endIndex - 1;
        upp.replace({ start: endBrace, end: endBrace }, upp.code`${node.text} `);
    }

    // 4. Strip the expression from the original site
    return "";
}

int main() {
    char *str1 = malloc(100);
    @defer { free(str1); str1 = NULL; }
    char *str2;

    {
        char *nested = malloc(100);
        @defer { free(nested); nested = NULL; }
        if (some_condition) {
            // should defer here, str1
            return 1;
        }
    }
    str2 = malloc(100);
    @defer { free(str2); str2 = NULL; }

    // should defer here, str2 then str1
    return 0;
}
