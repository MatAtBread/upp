#include "extern_methods.h"
int main() {
    Foo f = { .x = 1 };
    f.increment();
    f.print();
    return 0;
}