@define longify(name) {
    upp.registerTransform((root, helpers) => {
        helpers.matchReplace(root, `int ${name} = $val__number_literal;`, ({x,val}) => {
            return upp.code`long ${name} = ${val}L;`;
        }, { deep: true });
    });
}

@longify(bar)
@longify(baz)

int foo = 100;
int bar = 200;

void f() {
    int bar = 4;
}

int main() {
    int bar = 5;
    int baz = 5;
    return 0;
}