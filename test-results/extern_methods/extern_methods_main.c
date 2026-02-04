#include "extern_methods.h"
int main() {
    Foo f = { .x = 1 };
    _Foo_method_increment(&(f));
    _Foo_method_print(&(f));
    return 0;
}
