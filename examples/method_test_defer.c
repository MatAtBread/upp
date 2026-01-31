#include "io-lite.h"
#include "../std/method.h"
#include "../std/defer.h"

struct TestStruct {
    int x;
};
typedef struct TestStruct TestStruct;

@method(TestStruct) void Defer(TestStruct *t) {
    printf("Defer called for x=%d\n", t->x);
}

int main() {
    printf("Scope Start\n");
    {
        TestStruct t;
        t.x = 42;
        printf("Inner scope\n");
    }
    printf("Scope End\n");
    return 0;
}
