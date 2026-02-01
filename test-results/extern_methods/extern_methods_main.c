/* upp examples/extern_methods/extern_methods_main.c */



struct Foo {
    int x;
};
typedef struct Foo Foo;
extern /* @method(Foo) void print(Foo *f) */ void  _Foo_method_print(Foo *f);
/* @method(Foo) void increment(Foo *f); */ void _Foo_method_increment(Foo *f); 
int main() {
    Foo f = { .x = 1 };
    /* f.increment() */ _Foo_method_increment(&(f));
    /* f.print() */ _Foo_method_print(&(f));
    return 0;
}

