/* upp examples/method_test.c */



extern int puts (const char *s);
extern int printf (const char *format, ...);
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
/* @method(struct Base) int getX(struct Base *b) {
    return b->x;
}
@method(BaseTypedef) void setX(BaseTypedef *b, int v) {
    b->x = v;
}
@method(Unique) int getY(Unique *u) {
    return u->y;
} */ int _Base_method_getX(struct Base *b) {
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
    int val1 = /* b.getX() */ _Base_method_getX(&(b));
    /* bt.setX(50) */ _BaseTypedef_method_setX(&(bt), 50);
    int val2 = /* bt.getX() */ _Base_method_getX(&(bt));
    int val3 = /* u.getY() */ _Unique_method_getY(&(u));
    printf("val1: %d\n", val1);
    printf("val2: %d\n", val2);
    printf("val3: %d\n", val3);
    return 0;
}

