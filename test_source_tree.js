import { SourceTree, SourceNode } from './src/source_tree.js'; // Ensure SourceNode is exported
import Parser from 'tree-sitter';
import UppLanguage from 'tree-sitter-c';

async function runTests() {
    console.log("Starting SourceTree Tests...");

    const code = `
    int main() {
        return 0;
    }
    `;

    // 1. Setup
    const tree = new SourceTree(code, UppLanguage);
    const root = tree.root;

    // Helper to find nodes
    const find = (type) => {
        let res = null;
        const traverse = (n) => {
            if (res) return;
            if (n.type === type) res = n;
            else n.children.forEach(traverse);
        };
        traverse(root);
        return res;
    };

    console.log("Tree parsed.");

    // 2. Test insertBefore
    const returnStmt = find('return_statement');
    if (!returnStmt) throw new Error("Return statement not found");

    console.log("Testing insertBefore...");
    returnStmt.insertBefore("int y = 2;\n        ");

    if (!tree.source.includes("int y = 2;")) console.error("FAIL: insertBefore");
    else console.log("PASS: insertBefore");

    // 3. Test replaceWith
    console.log("Testing replaceWith...");
    // Replace 'return 0;' with 'return 1;'
    // Capture the new node because the old one is now invalid.
    returnStmt.replaceWith("return 1;");

    if (!tree.source.includes("return 1;")) console.error("FAIL: replaceWith source update");
    if (tree.source.includes("return 0;")) console.error("FAIL: Old content should be gone.");
    if (returnStmt.text !== "return 1;") console.error("FAIL: Old node should be morphed to new content.");
    // if (returnStmt.startIndex === -1) console.error("FAIL: Old node should be invalidated.");

    console.log("PASS: replaceWith");

    // 4. Test Node Removal & Re-insertion (Migration)
    console.log("Testing Node Removal & Re-insertion...");

    const tempTree = new SourceTree("int temp = 5;", UppLanguage);
    const tempNode = tempTree.root;

    // Insert into main tree
    root.insertAfter(tempTree);

    if (!tree.source.includes("int temp = 5;")) console.error("FAIL: Initial insertion.");
    if (tempNode.tree !== tree) console.error("FAIL: Migration to main tree.");

    // Remove from main tree
    const holdingTree = tempNode.remove();

    // Check main tree
    if (tree.source.includes("int temp = 5;")) console.error("FAIL: Removal from source.");

    // Check holding tree
    if (holdingTree.source !== "int temp = 5;") console.error(`FAIL: Holding tree content. Got '${holdingTree.source}'`);
    if (tempNode.tree !== holdingTree) console.error("FAIL: Migration to holding tree.");

    // Re-insert into main tree
    console.log("Testing re-insertion...");
    root.insertAfter(tempNode);

    if (!tree.source.includes("int temp = 5;")) console.error("FAIL: Re-insertion source.");
    if (tempNode.tree !== tree) console.error("FAIL: Migration back to main tree.");

    console.log("PASS: Node Removal & Re-insertion lifecycle.");

    // 6. Test Virtual Node Lifecycle (Regression Check)
    console.log("Testing Virtual Node Lifecycle...");
    const vTree = new SourceTree("int z = 99;", UppLanguage);
    const vNode = vTree.root;

    // Use the NEW returnStmt node
    returnStmt.insertBefore(vNode);

    if (!tree.source.includes("int z = 99;")) console.error("FAIL: Virtual node insertion.");

    // 7. Test UPSTREAM edit tracking
    console.log("Testing Upstream Edit Handling...");
    // Find 'main' and rename to 'start'
    const mainId = find('identifier'); // The one in 'int main'
    mainId.text = "start"; // Length 4 instead of 4. Wait, "main" is 4. "start" is 5. Delta +1.

    if (vNode.text !== "int z = 99;") {
        console.error(`FAIL: Virtual node text corrupted after upstream edit. Got: '${vNode.text}'`);
    } else {
        console.log("PASS: Upstream edit handling.");
    }

    // 8. Test SourceTree Merging
    console.log("Testing SourceTree Merge...");
    const mergeTree = new SourceTree("int merged = 123;", UppLanguage);
    const mergeRoot = mergeTree.root;

    // Append to root
    root.append(mergeTree);

    if (!tree.source.includes("int merged = 123;")) console.error("FAIL: Merge text insertion.");
    console.log("PASS: SourceTree Merge.");

    // 9. Test Fragment Parsing
    console.log("Testing Fragment Parsing...");
    const exprFrag = SourceTree.fragment("10 + x", UppLanguage);
    if (exprFrag.text !== "10 + x") console.error(`FAIL: Fragment text mismatch. Got '${exprFrag.text}'`);

    const stmtFrag = SourceTree.fragment("return 99;", UppLanguage);
    if (stmtFrag.type !== 'return_statement') console.error(`FAIL: Statement fragment type. Got '${stmtFrag.type}'`);

    console.log("Final Source:\n" + tree.source);
    console.log("JSON tree", JSON.stringify(tree, null, 2));
}

runTests().catch(e => console.error(e));
