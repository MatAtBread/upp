
int  x_trap_0(int  value) { return value * 2; }

int  z_trap_1(int  value) { return value + 1; }
#include "trap.h"
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
int my_logger(int v) {
    printf("Logging value: %d\n", v);
    return v;
}
struct Point {
    int x; 
    int y; 
};
int main() {
    struct Point p;
    p.x = x_trap_0(10);
    p.y = my_logger(5);
    int z = z_trap_1(10); 
    z = z_trap_1(20);
    printf("p.x=%d, p.y=%d, z=%d\n", p.x, p.y, z);
    return 0;
}
