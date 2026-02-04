extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "extern_methods.h"
void _Foo_method_print(Foo *f) {
    printf("Foo %d\n", f->x);
} 
void _Foo_method_increment(Foo *f) {
    f->x++;
} 
