#include "../../std/method.hup"

struct Foo {
    int x;
};
typedef struct Foo Foo;

extern @method(Foo) void print(Foo *f);
