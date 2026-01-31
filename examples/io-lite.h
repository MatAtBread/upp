/* A minimal C stdio/stdlib for upp to make it easy to
   see the output of the examples but permit compilation
*/
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(int n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#define NULL ((void*)0)