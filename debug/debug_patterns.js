import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

function debug(src) {
    const tree = parser.parse(src);
    console.log(`Source: "${src}"`);

    function dump(node, indent = "") {
        console.log(`${indent}${node.type} [${node.startIndex}, ${node.endIndex}] "${node.text}"`);
        for (let i = 0; i < node.childCount; i++) {
            dump(node.child(i), indent + "  ");
        }
    }

    // Find interesting root
    let root = tree.rootNode;
    if (root.type === 'translation_unit') {
        for(let i=0; i<root.childCount; i++) {
            if (root.child(i).type !== 'comment') {
                root = root.child(i);
                break;
            }
        }
    }
    dump(root);
}

console.log("--- Pattern: Direct ---");
debug("z = $expr");
console.log("\n--- Pattern: Direct with Semicolon ---");
debug("z = $expr;");
console.log("\n--- Pattern: Field ---");
debug("$obj.x = $expr");
console.log("\n--- Pattern: Field with Semicolon ---");
debug("$obj.x = $expr;");
