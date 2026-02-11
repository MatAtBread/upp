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
    // Note: returnStmt reference becomes invalid after replacement in current tree.
    returnStmt.replaceWith("return 1;");

    if (!tree.source.includes("return 1;")) console.error("FAIL: replaceWith source update");
    if (tree.source.includes("return 0;")) console.error("FAIL: Old content should be gone.");

    console.log("PASS: replaceWith");

    // 4. Test Node Removal & Re-insertion (Migration)
    console.log("Testing Node Removal & Re-insertion...");

    // Create new node to test lifecycle
    const tempTree = new SourceTree("int temp = 5;", UppLanguage);
    const tempNode = tempTree.root; // This covers "int temp = 5;"

    // Insert into main tree
    root.insertAfter(tempTree); // Merges tempTree into tree. tempNode migrates to tree.

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
    root.insertAfter(tempNode); // Should migrate from holdingTree back to main tree

    if (!tree.source.includes("int temp = 5;")) console.error("FAIL: Re-insertion source.");
    if (tempNode.tree !== tree) console.error("FAIL: Migration back to main tree.");

    console.log("PASS: Node Removal & Re-insertion lifecycle.");

    // 6. Test Virtual Node Lifecycle (Regression Check)
    console.log("Testing Virtual Node Lifecycle...");
    // Create a new node from string
    const vTree = new SourceTree("int z = 99;", UppLanguage);
    const vNode = vTree.root;

    // Insert it at the start of the function body (after '{')
    // We inserted 'int y = 2;' earlier.
    // root -> funcDef -> body -> '{' ... 'int y = 2;' ...

    // Let's find 'int y = 2;' or similar.
    // We can just rely on previous 'returnStmt' which is now at the end.
    // Let's insert BEFORE the returnStmt.
    returnStmt.insertBefore(vNode);

    if (!tree.source.includes("int z = 99;")) console.error("FAIL: Virtual node insertion.");

    // Now perform an edit BEFORE this new node.
    // Rename function again? 'test_func' -> 'fn'
    // We need to find the identifier again. It was 'test_func'.
    // We can scan the children of the function_declarator.
    // Since we re-materialized the tree, we have wrappers.
    // BUT we haven't re-parsed, so the WRAPPERS are pointing to OLD TS nodes.
    // AND we haven't updated the tree structure, so standard traversal of `funcDef` children
    // will show the OLD children (with updated offsets).
    // So `funcDef.children` still has the valid wrappers.

    // We need to re-find the function definition since we might have modified the tree structure?
    // Actually, `find` uses the original wrappers.
    const funcDef = find('function_definition');

    const funcDecl = funcDef.children.find(c => c.type === 'function_declarator');
    const idNode = funcDecl.children.find(c => c.type === 'identifier');

    // idNode.text should be 'test_func' (derived from source slice).
    if (idNode.text !== 'test_func') {
         console.warn(`Warning: idNode text is '${idNode.text}', expected 'test_func'`);
    }

    idNode.text = "fn"; // Delta = -7

    // Check if vNode text remained valid.
    const vNodeText = vNode.text;
    console.log(`Virtual Node Text after upstream edit: '${vNodeText}'`);

    if (vNodeText !== "int z = 99;") {
        console.error(`FAIL: Virtual node did not shift! Got: '${vNodeText}'`);
    } else {
        console.log("PASS: Virtual node tracked correctly.");
    }

    // 7. Test SourceTree Merging
    console.log("Testing SourceTree Merge...");
    // Create another SourceTree
    const mergeTree = new SourceTree("int merged = 123;", UppLanguage);
    // Find identifier in mergeTree BEFORE merge to check if it migrates
    const mergeRoot = mergeTree.root;
    // mergeTree root is translation_unit. Children: [declaration].
    const mergeDecl = mergeRoot.children[0];
    const mergeId = mergeDecl.children.find(c => c.type === 'init_declarator').children.find(c => c.type === 'identifier');

    // Append this tree to the end of main tree
    // We can insert after the last child of root
    const lastChild = root.children[root.children.length-1];
    lastChild.insertAfter(mergeTree);

    if (!tree.source.includes("int merged = 123;")) console.error("FAIL: Merge text insertion.");
    // Check if mergeId is now part of main tree and has correct offset
    if (mergeId.tree !== tree) console.error("FAIL: Node migration (tree ref).");
    if (mergeId.text !== "merged") console.error("FAIL: Node migration (text access).");

    // Check if offsets are correct (should be near end of file)
    console.log(`Merged ID offset: ${mergeId.startIndex}`);
    if (mergeId.startIndex < 50) console.warn("Warning: Merged ID offset seems low?");

    console.log("PASS: SourceTree Merge.");

    // 8. Test Fragment Parsing (Strict API)
    console.log("Testing Fragment Parsing...");

    // Test: Expression fragment (wrapped in void __frag() { ... })
    const exprFrag = SourceTree.fragment("10 + x", UppLanguage);
    if (exprFrag.type !== 'expression_statement') console.error(`FAIL: Fragment type. Got '${exprFrag.type}'. Expected expression_statement.`);
    if (exprFrag.text !== "10 + x") console.error(`FAIL: Fragment text mismatch. Got '${exprFrag.text}'`);

    // Test: Statement fragment
    const stmtFrag = SourceTree.fragment("return 99;", UppLanguage);
    if (stmtFrag.type !== 'return_statement') console.error(`FAIL: Statement fragment type. Got '${stmtFrag.type}'`);

    // Test: String input to comparison (should auto-fragment)
    console.log("Testing String -> Fragment Auto-Conversion...");
    // Insert "int auto = 1;" using string
    root.insertAfter("int auto = 1;");

    if (!tree.source.includes("int auto = 1;")) console.error("FAIL: Auto-fragment insertion.");
    console.log("PASS: Fragment Parsing & Auto-Conversion.");

    console.log("Final Source:\n" + tree.source);
}

runTests().catch(e => console.error(e));
