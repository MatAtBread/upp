/* upp examples/nested_macros_5.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
static int expanded_inner = 5;


int main() {
    int n = /* @outer(20) @inner(10) */ /* @inner(10) */ expanded_inner + 10 + 20 ;
    printf("%d\n", n);
    return 0;
}

