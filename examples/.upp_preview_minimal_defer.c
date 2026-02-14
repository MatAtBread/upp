/* A minimal C stdio/stdlib for upp to make it easy to
   see the output of the examples but permit compilation
*/
extern int puts(const char *s);
extern int printf(const char *format, ...);
extern int fputs(const char *s, void *stream);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
extern void *stderr;
extern void *_stderr;

#include "defer.h"
int main() {
    char *str1 = malloc(100);
    printf("allocated\n");
     
    str1[0] = 0;
    printf("returning\n");
    { free(str1); str1 = ((void *)0); printf("deferred\n"); }
return 0;
}
