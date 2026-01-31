/* upp examples/trap.c */


int  x_trap_0(int  value) { return value * 2; }
int  z_trap_1(int  value) { return value + 1; }
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(int n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
int my_logger(int v) {
    printf("Logging value: %d\n", v);
    return v;
}
struct Point {
    /* @trap({ return value * 2; }) int x;
    @trap(my_logger) int y; */ int x; 
    int y; 
};
int main() {
    struct Point p;
    p.x = /* 10 */ x_trap_0(10);
    p.y = /* 5 */ my_logger(5);
    /* @trap({ return value + 1; }) int z = 10; */ int z = z_trap_1(10); 
    z = /* 20 */ z_trap_1(20);
    printf("p.x=%d, p.y=%d, z=%d\n", p.x, p.y, z);
    return 0;
}

