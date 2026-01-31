
/* examples/lambda.c */

#include <stdio.h>


struct lambda_ctx_0 {
    int *direction;
    char * *name;

};

void hello_impl_1(struct lambda_ctx_0 *ctx, int num) {
        const char *salutation = (*ctx->direction) ? "Hello" : "Bye";
        printf("%s %s %d\n", salutation, (*ctx->name), num);
    }



int main() {
    char *name = "Diego";
    int direction = 1;
    /* @lambda void hello(int num) {
        const char *salutation = direction ? "Hello" : "Bye";
        printf("%s %s %d\n", salutation, name, num);
    }

    hello(1) */ struct lambda_ctx_0 ctx = { .direction = &direction, .name = &name };

    hello_impl_1(&ctx, 1);
    name = "Fabio";
    /* hello(2) */ hello_impl_1(&ctx, 2);
    direction = 0;
    /* hello(3 ) */ hello_impl_1(&ctx, 3 );

    /* const (void (*z)(int)) = hello;
    z(4) */ const typeof(&hello_impl_1) z = hello_impl_1;
    z(&ctx, 4);

    return 0;
}
