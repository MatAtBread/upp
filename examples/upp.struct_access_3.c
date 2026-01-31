
/* examples/struct_access_3.c */



struct Point {
    int x;
    int y;
};
typedef struct Point Point;

/* @method(Point) */  int /* distance */ _Point_method_distance(Point *p) {
    return p->x * p->x + p->y * p->y;
}

int main() {
    Point p;
    p.x = 10;
    p.y = 20;
    int r = /* p.distance() */ _Point_method_distance(&(p));
    return 0;
}

