
/* examples/upp.type_refs_test.c */


/* examples/type_refs_test.c */



/* @rename_type(RealPoint) */ 
typedef struct /* PointAlias */ RealPoint {
    int x;
    int y;
} /* PointAlias */ RealPoint;

/* @rename_type(PointTag) */ 
struct /* PointTagDef */ PointTag {
    int x;
};

int main() {
    /* PointAlias */ RealPoint p1;
    struct /* PointTagDef */ PointTag p2;

    p1.x = 10;
    p2.x = 20;

    return 0;
}


