import { SourceTree, SourceNode } from './src/source_tree.js';
import Parser from 'tree-sitter';
import UppLanguage from 'tree-sitter-c';

async function testStability() {
    console.log("Testing Orphaned Nodes...");
    const tree = new SourceTree("int x = 1;", UppLanguage);
    const root = tree.root;
    const decl = root.children[0];
    const initDecl = decl.children.find(c => c.type === 'init_declarator');
    const idNode = initDecl.children.find(c => c.type === 'identifier');

    console.log(`Original ID Node: ${idNode.id} (${idNode.text})`);

    // Replace the whole declaration
    decl.replaceWith("float y = 2.0;");

    console.log(`Old ID Node startIndex: ${idNode.startIndex}`);
    // It should be -1 if we invalidated it, but we only invalidated the parent (decl).
    // If it's still in the cache, it's a leak.
    if (tree.nodeCache.has(idNode.id)) {
        console.warn("LEAK: Old child still in nodeCache after parent replacement!");
    }

    console.log("Testing append() return value...");
    const appendTree = new SourceTree("int a;", UppLanguage);
    const result = root.append(appendTree);
    if (result === undefined) {
        console.error("FAIL: append() returns undefined");
    } else {
        console.log("PASS: append() returns something");
    }
}

testStability().catch(console.error);
