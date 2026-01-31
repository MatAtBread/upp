#include <stdio.h>
#include "../std/lambda.h"

int main() {
    char *name = "Diego";
    int direction = 1;
    @lambda void hello(int num) {
        const char *salutation = direction ? "Hello" : "Bye";
        printf("%s %s %d\n", salutation, name, num);
    }

    hello(1);
    name = "Fabio";
    hello(2);
    direction = 0;
    hello(3 );

    const (void (*z)(int)) = hello;
    z(4);

    return 0;
}