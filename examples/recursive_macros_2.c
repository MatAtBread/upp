@define method(structName) {
    // 1. Eat the node (it's marked for deletion)
    const funcDef = upp.consume();

    // 2. Extract parts from the consumed node
    const funcDeclarator = funcDef.childForFieldName('declarator');
    const funcIdentifier = funcDeclarator.childForFieldName('declarator');
    const returnType = funcDef.childForFieldName('type');
    const params = funcDeclarator.childForFieldName('parameters');
    const body = funcDef.childForFieldName('body');

    // 3. Construct new name
    const originalName = funcIdentifier.text;
    const newName = `_${structName}_method_${originalName}`;

    // 4. Register transformation (same as before)
    upp.registerTransform((root, helpers) => {
        const queryText = `
            (call_expression
                function: (field_expression
                    argument: (_) @obj
                    field: (field_identifier) @field
                ) @fn
                arguments: (argument_list) @args
            ) @call
        `;
        const matches = helpers.query(queryText, root);
        for (const m of matches) {
            if (m.captures.field.text === originalName) {
                const operator = m.captures.fn.child(1).text;
                const objRef = operator === '.' ? `&(${m.captures.obj.text})` : m.captures.obj.text;
                const argsList = m.captures.args.text.slice(1, -1);
                const finalArgs = objRef + (argsList.trim() ? ', ' + argsList : '');
                helpers.replace(m.captures.call, helpers.code`${newName}(${finalArgs})`);
            }
        }
    });

    // 5. Handle Defer (same as before)
    if (originalName === 'Defer') {
        const matches = upp.query(`(declaration type: (type_identifier) @type) @decl`, upp.root);
        for (const m of matches) {
            if (m.captures.type.text === structName) {
                const declNode = m.captures.decl;
                for (let i = 0; i < declNode.childCount; i++) {
                    const child = declNode.child(i);
                    if (child.type === 'identifier') {
                        const varName = child.text;
                        upp.replace({ start: declNode.endIndex, end: declNode.endIndex }, upp.code` @defer ${varName}.Defer();`);
                    }
                }
            }
        }
    }

    // 6. Return the reconstructed replacement
    // We consumed the function, so we must return the new version to take its place.
    return upp.code`${returnType.text} ${newName}${params.text} ${body.text}`;
}

@define defer() {
    const node = upp.consume();
    const scope = upp.findEnclosing(node, 'compound_statement');
    if (!scope) return;

    const absStart = (node.tree && node.tree === upp.root.tree) ? node.startIndex : upp.invocation.startIndex;

    const safetyMatches = upp.query(`
        (break_statement) @break
        (continue_statement) @continue
        (goto_statement) @goto
    `, scope);
    for (const m of safetyMatches) {
        if (m.node.startIndex > absStart) {
            throw new Error(`@defer cannot be used in a scope containing ${m.node.type.replace('_statement', '')}`);
        }
    }

    const returnMatches = upp.query(`(return_statement) @ret`, scope);
    for (const m of returnMatches) {
        if (m.captures.ret.startIndex > absStart) {
            upp.replace({ start: m.captures.ret.startIndex, end: m.captures.ret.startIndex }, upp.code`${node.text} `);
        }
    }

    const lastStmt = scope.lastNamedChild;
    if (lastStmt && lastStmt.type !== 'return_statement' && lastStmt.startIndex > absStart) {
        const endBrace = scope.endIndex - 1;
        upp.replace({ start: endBrace, end: endBrace }, upp.code`${node.text} `);
    }

    return "";
}

struct String {
    char *data;
};

@method(String) void Defer(String *s) {
    printf("Freeing string: %s\n", s->data);
    free(s->data);
}

int main() {
    String s1;
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");

    if (some_condition) {
        return 1;
    }

    return 0;
}
