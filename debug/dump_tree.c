@define dump_tree() {
    upp.walk(upp.root, (n) => {
        console.log(`${'  '.repeat(n.level || 0)}${n.type}: ${n.text.slice(0, 20)}`);
    });
}

@dump_tree();
