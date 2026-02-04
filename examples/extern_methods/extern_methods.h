#include "method.h"
struct Foo {
    int x;
};
typedef struct Foo Foo;
extern void  _Foo_method_print(Foo *f);
void _Foo_method_increment(Foo *f); 
