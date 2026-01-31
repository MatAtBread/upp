#ifndef __UPP_STDLIB_DEFER_H__
#define __UPP_STDLIB_DEFER_H__

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

#endif
