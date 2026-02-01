import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

function dump(node, indent = "") {
    console.log(`${indent}${node.type} [${node.startIndex}, ${node.endIndex}] "${node.text}"`);
    for (let i = 0; i < node.childCount; i++) {
        dump(node.child(i), indent + "  ");
    }
}

const patternStr = "$obj.print($args)";
const tree = parser.parse(patternStr);
dump(tree.rootNode);
