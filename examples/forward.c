#include "../std/forward.h"

@forward;

void foo() {
    printf("Foo calls bar\n");
    bar();
}

void bar() {
    printf("Bar called\n");
}

int main() {
    foo();
    return 0;
}
