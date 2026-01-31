@define task() {
    const node = upp.consume('expression_statement');
    let call = (node.type === 'expression_statement') ? node.child(0) : node;
    if (call.type !== 'call_expression') {
        upp.error(node, "@task must be applied to a function call");
    }
    const name = call.childForFieldName('function').text;
    return upp.code`os_start(${name});`;
}

void hello() {
    printf("World\n");
}

void os_start(void (*task)()) {
    task();
}

int main() {
    @task hello();
    return 0;
}
