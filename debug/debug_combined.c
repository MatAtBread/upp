@define dump_tree() {
    upp.walk(upp.root, (n) => {
        // Simple level hack
        let l = 0;
        let p = n.parent;
        while(p) { l++; p = p.parent; }
        console.log(`${'  '.repeat(l)}${n.type}: ${n.text.slice(0, 30).replace(/\n/g, ' ')}`);
    });
}

@dump_tree();

typedef struct Point {
    int x;
} Point;

struct Point p1;
Point p2;
