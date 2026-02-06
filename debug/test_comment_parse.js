import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

const source = `
int main() {
    /*@allocate(100)*/ char *str1;
    return 0;
}
`;

const tree = parser.parse(source);

function printTree(node, indent = '') {
    console.log(`${indent}${node.type} [${node.startIndex}-${node.endIndex}] "${node.text.substring(0, 40).replace(/\n/g, '\\n')}"`);
    for (let i = 0; i < node.childCount; i++) {
        printTree(node.child(i), indent + '  ');
    }
}

printTree(tree.rootNode);
