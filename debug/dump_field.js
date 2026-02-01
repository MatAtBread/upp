import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

const patternStr = "$obj.print";
const tree = parser.parse(patternStr);
function dump(node, indent = "") {
    console.log(`${indent}${node.type} [${node.startIndex}, ${node.endIndex}] "${node.text}"`);
    for (let i = 0; i < node.childCount; i++) {
        dump(node.child(i), indent + "  ");
    }
}
dump(tree.rootNode);
