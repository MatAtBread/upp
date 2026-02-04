extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "mypkg.h"
int add(int a, int b) {
    return (a + b) * 10;
}
int main() {
    int x = add(1, 2);
    int y = mypkg_add(1, 2);
    printf("Local add: %d\n", x);
    printf("Pkg add: %d\n", y);
    if (x == 30 && y == 3) {
        printf("SUCCESS\n");
        return 0;
    }
    printf("FAILURE\n");
    return 1;
}
