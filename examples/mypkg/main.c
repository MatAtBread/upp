/* A minimal C stdio/stdlib for upp to make it easy to
   see the output of the examples but permit compilation
*/
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "mypkg.h"
// This 'add' should NOT be renamed because we are a consumer, not the implementation.
// There is no @implements(mypkg) here.
int mypkg_add(int a, int b) {
    return (a + b) * 10;
}
int mypkg_main() {
    int x = mypkg_add(1, 2); // Should call local add -> 30
    int y = mypkg_add(1, 2); // Should call pkg add -> 3
    printf("Local add: %d\n", x);
    printf("Pkg add: %d\n", y);
    if (x == 30 && y == 3) {
        printf("SUCCESS\n");
        return 0;
    }
    printf("FAILURE\n");
    return 1;
}
