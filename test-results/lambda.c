

struct lambda_ctx_0 {
 int  *direction;
 char * *name;

};

void hello_impl_1(struct lambda_ctx_0 *ctx, int num) {
        const char *salutation = (*ctx->direction) ? "Hello" : "Bye";
        printf("%s %s %d\n", salutation, (*ctx->name), num);
    }
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "lambda.h"
int main() {
    char *name = "Diego";
    int direction = 1;
    struct lambda_ctx_0 ctx = { .direction = &direction, .name = &name };
    hello_impl_1(&ctx, 1);
    name = "Fabio";
    hello_impl_1(&ctx, 2);
    direction = 0;
    hello_impl_1(&ctx, 3 );
    typeof(&hello_impl_1) z = hello_impl_1;
    z(&ctx, 4);
    return 0;
}
