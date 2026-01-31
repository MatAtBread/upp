
/* examples/upp.struct_access.c */


/* examples/struct_access.c */



struct Point {
    int x;
    int y;
};

/* @method(Point) */  int /* distance */ _Point_method_distance(Point *p) {
    return p->x * p->x + p->y * p->y;
}

int main() {
    Point p;
    int r = /* p.distance() */ _Point_method_distance(&(p));
    return 0;
}


