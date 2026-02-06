#include "method.h"
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
struct Base {
    int x;
};
typedef struct Base BaseTypedef;
typedef struct {
    int y;
} Unique;
int _Base_method_getX(struct Base *b) {
    return b->x;
} 
void _BaseTypedef_method_setX(BaseTypedef *b, int v) {
    b->x = v;
} 
int _Unique_method_getY(Unique *u) {
    return u->y;
} 
int main() {
    struct Base b = { 10 };
    BaseTypedef bt = { 20 };
    Unique u = { 100 };
    int val1 = _Base_method_getX(&(b));
    _BaseTypedef_method_setX(&(bt), 50);
    int val2 = _Base_method_getX(&(bt));
    int val3 = _Unique_method_getY(&(u));
    printf("val1: %d\n", val1);
    printf("val2: %d\n", val2);
    printf("val3: %d\n", val3);
    return 0;
}