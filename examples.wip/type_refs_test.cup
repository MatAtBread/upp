@define rename_type(newName) {
    const node = upp.contextNode;
    // Applied to a type declaration (struct tag or typedef)
    const refs = upp.findReferences(node);
    for (const ref of refs) {
        upp.replace(ref, newName);
    }
}

@rename_type(RealPoint)
typedef struct PointAlias {
    int x;
    int y;
} PointAlias;

@rename_type(PointTag)
struct PointTagDef {
    int x;
};

int main() {
    PointAlias p1;
    struct PointTagDef p2;

    p1.x = 10;
    p2.x = 20;

    return 0;
}
