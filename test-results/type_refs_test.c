

typedef struct PointAlias {
    int x;
    int y;
} PointAlias;

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
