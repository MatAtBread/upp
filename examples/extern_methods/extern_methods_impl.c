#include "../io-lite.h"
#include "extern_methods.h"

@method(Foo) void print(Foo *f) {
    printf("Foo %d\n", f->x);
}