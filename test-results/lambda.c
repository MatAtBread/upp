/* upp examples/lambda.c */



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
    /* typeof(hello) z = hello;
    z(4) */ typeof(&hello_impl_1) z = hello_impl_1;
    z(&ctx, 4);
    return 0;
}

