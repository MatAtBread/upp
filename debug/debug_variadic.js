import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

function debug(patternStr, targetStr) {
    const pTree = parser.parse(patternStr);
    const tTree = parser.parse(targetStr);

    function getRoot(tree) {
        let n = tree.rootNode;
        while (n.type === 'translation_unit' && n.childCount > 0) {
             let found = false;
             for(let i=0; i<n.childCount; i++) {
                 if(n.child(i).type !== 'comment') {
                     n = n.child(i);
                     found = true;
                     break;
                 }
             }
             if (!found) break;
        }
        return n;
    }

    const pRoot = getRoot(pTree);
    const tRoot = getRoot(tTree);

    function match(t, p) {
        if (p.type === 'identifier' && p.text.startsWith('$')) return true;
        if (t.type !== p.type) return false;
        if (t.childCount === 0 && p.childCount === 0) return t.text === p.text;

        const tc = []; for(let i=0; i<t.childCount; i++) if(t.child(i).type !== 'comment') tc.push(t.child(i));
        const pc = []; for(let i=0; i<p.childCount; i++) if(p.child(i).type !== 'comment') pc.push(p.child(i));

        if (tc.length !== pc.length) return false;
        for(let i=0; i<tc.length; i++) {
            if (!match(tc[i], pc[i])) return false;
        }
        return true;
    }

    // Unwrap expression_statement if no semi
    let pFinal = pRoot;
    if (pFinal.type === 'expression_statement' && !patternStr.endsWith(';')) pFinal = pFinal.child(0);

    let tFinal = tRoot;
    if (tFinal.type === 'expression_statement') tFinal = tFinal.child(0);

    const ok = match(tFinal, pFinal);
    console.log(`Pattern: "${patternStr}" vs Target: "${targetStr}" -> ${ok ? "MATCH" : "FAIL"}`);
    if (!ok) console.log(`  P Final Type: ${pFinal.type}, T Final Type: ${tFinal.type}`);
}

debug("$func($args)", "f.print()");
debug("$func($args)", "f.print(1)");
debug("$func($args)", "f.print(1, 2)");
debug("$func($args)", "print()");
