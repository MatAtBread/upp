
/* examples/method_test.c */



#include <stdio.h>

struct Base {
    int x;
};

typedef struct Base BaseTypedef;

typedef struct {
    int y;
} Unique;

// 1. method(struct Tag)
/* @method(struct Base) */  int /* getX */ _Base_method_getX(struct Base *b) {
    return b->x;
}

// 2. method(Typedef)
/* @method(BaseTypedef) */  void /* setX */ _BaseTypedef_method_setX(BaseTypedef *b, int v) {
    b->x = v;
}

// 3. method(UniqueTypedef)
/* @method(Unique) */  int /* getY */ _Unique_method_getY(Unique *u) {
    return u->y;
}

int main() {
    struct Base b = { 10 };
    BaseTypedef bt = { 20 };
    Unique u = { 100 };

    // Usage 1
    int val1 = /* b.getX() */ _Base_method_getX(&(b));

    // Usage 2
    /* bt.setX(50) */ _BaseTypedef_method_setX(&(bt), 50);
    int val2 = /* bt.getX() */ _Base_method_getX(&(bt));

    // Usage 3
    int val3 = /* u.getY() */ _Unique_method_getY(&(u));

    printf("val1: %d\n", val1);
    printf("val2: %d\n", val2);
    printf("val3: %d\n", val3);

    return 0;
}

