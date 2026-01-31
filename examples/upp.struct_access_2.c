
/* examples/struct_access_2.c */



struct Point {
    int x;
    int y;
};
typedef struct Point Point;

// No parentheses! Scavenging style.
/* @method Point */  int /* distance */ _Point_method_distance(Point *p) {
    return p->x * p->x + p->y * p->y;
}

int main() {
    Point p;
    int r = /* p.distance() */ _Point_method_distance(&(p));
    return 0;
}

