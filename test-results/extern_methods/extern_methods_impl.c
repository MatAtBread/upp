/* upp examples/extern_methods/extern_methods_impl.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);

struct Foo {
    int x;
};
typedef struct Foo Foo;
extern /* @method(Foo) void print(Foo *f) */ void  _Foo_method_print(Foo *f);
/* @method(Foo) void print(Foo *f) {
    printf("Foo %d\n", f->x);
} */ void _Foo_method_print(Foo *f) {
    printf("Foo %d\n", f->x);
} 

