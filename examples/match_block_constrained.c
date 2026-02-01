@define transform_if() {
    upp.registerTransform((root, helpers) => {
        // Find: if ($cond) $then;
        // Replace with: if ($cond) { $then } (enforce braces)

        // Loop deep match
        // Note: upp.match deep search returns first match.
        // We need to iterate or match repeatedly?
        // Let's use loop.

        // Just match context node? Or look for specific node?
        // Let's iterate function definitions.

        const funcs = helpers.query('(function_definition) @f', root);
        for (const m of funcs) {
             const func = m.captures.f;
             // Search inside function body for if statements
             const ifs = helpers.query('(if_statement) @i', func);
             for (const ifMatch of ifs) {
                 const ifNode = ifMatch.captures.i;

                 helpers.matchReplace(ifNode, "if ($cond) $then__NOT_compound_statement;",
                 ({cond, then}) =>
                     helpers.code`if (${cond}) { ${then} }`
                 );
             }
        }
    });
}

@transform_if;

int main() {
    if (1) return 0;
    if (2) {
        return 0;
    }
}
