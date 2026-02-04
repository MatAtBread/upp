extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "method.h"
#include "defer.h"
struct TestStruct {
    int x;
};
typedef struct TestStruct TestStruct;
void _TestStruct_method_Defer(TestStruct *t) {
    printf("Defer called for x=%d\n", t->x);
} 
int main() {
    printf("Scope Start\n");
    {
        TestStruct t; 
        t.x = 42;
        printf("Inner scope\n");
    _TestStruct_method_Defer(&(t)); }
    printf("Scope End\n");
    return 0;
}
