import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const parser = new Parser();
parser.setLanguage(C);

function debug(patternStr, targetStr) {
    console.log(`Pattern: "${patternStr}"`);
    console.log(`Target:  "${targetStr}"`);

    const pTree = parser.parse(patternStr);
    const tTree = parser.parse(targetStr);

    function getRoot(tree) {
        let n = tree.rootNode;
        if (n.type === 'translation_unit') {
            for(let i=0; i<n.childCount; i++) {
                if(n.child(i).type !== 'comment') return n.child(i);
            }
        }
        return n;
    }

    const pRoot = getRoot(pTree);
    const tRoot = getRoot(tTree);

    console.log(`P Type: ${pRoot.type}`);
    console.log(`T Type: ${tRoot.type}`);

    // Manual structural match for debug
    function match(t, p) {
        if (p.text.startsWith('$')) {
            console.log(`  MATCH placeholder ${p.text} -> ${t.text} (${t.type})`);
            return true;
        }
        if (t.type !== p.type) {
            console.log(`  FAIL type ${t.type} !== ${p.type} for text "${t.text}" vs "${p.text}"`);
            return false;
        }
        if (t.childCount === 0 && p.childCount === 0) return t.text === p.text;

        const tc = []; for(let i=0; i<t.childCount; i++) if(t.child(i).type !== 'comment') tc.push(t.child(i));
        const pc = []; for(let i=0; i<p.childCount; i++) if(p.child(i).type !== 'comment') pc.push(p.child(i));

        if (tc.length !== pc.length) {
            console.log(`  FAIL child count ${tc.length} !== ${pc.length} for ${t.type}`);
            return false;
        }
        for(let i=0; i<tc.length; i++) {
            if (!match(tc[i], pc[i])) return false;
        }
        return true;
    }

    // Since PatternMatcher unwraps, let's drill down if pattern is expression_statement
    let pFinal = pRoot;
    if (pFinal.type === 'expression_statement' && !patternStr.endsWith(';')) {
        pFinal = pFinal.child(0);
        console.log(`  Unwrapped pattern to ${pFinal.type}`);
    }

    // Target might also be expression_statement
    let tFinal = tRoot;
    if (tFinal.type === 'expression_statement') {
        tFinal = tFinal.child(0);
        console.log(`  Unwrapped target to ${tFinal.type}`);
    }

    match(tFinal, pFinal);
}

debug("$obj.print($args)", "f.print()");
