/* upp examples/method_test_defer.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);



struct TestStruct {
    int x;
};
typedef struct TestStruct TestStruct;
/* @method(TestStruct) void Defer(TestStruct *t) {
    printf("Defer called for x=%d\n", t->x);
} */ void _TestStruct_method_Defer(TestStruct *t) {
    printf("Defer called for x=%d\n", t->x);
} 
int main() {
    printf("Scope Start\n");
    {
        /* TestStruct t; */ TestStruct t; /* @defer t.Defer(); */ 
        t.x = 42;
        printf("Inner scope\n");
    /* t.Defer() */ _TestStruct_method_Defer(&(t)); }
    printf("Scope End\n");
    return 0;
}

