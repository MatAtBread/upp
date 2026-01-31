/* upp examples/extern_methods/extern_methods_main.c */


struct Foo {
    int x;
};
typedef struct Foo Foo;
extern /* @method(Foo) void print(Foo *f) */ void  _Foo_method_print(Foo *f);
int main() {
    Foo f;
    f.x = 1;
    /* f.print() */ _Foo_method_print(&(f));
    return 0;
}

