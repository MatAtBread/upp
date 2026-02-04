@define transform_if() {
    upp.registerTransform((root, helpers) => {
        // Find: if ($cond) $then;
        // Replace with: if ($cond) { $then } (enforce braces)
        // Loop deep match
        helpers.matchReplace(root, "if ($cond) $then__NOT_compound_statement;",
            ({cond, then}) => helpers.code`if (${cond}) { ${then} }`,
            { deep: true });
    });
}

@transform_if;

int main() {
    if (1) return 0;
    if (2) {
        return 0;
    }
}
