extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "defer.h"
int some_condition;
int main() {
    char *str1 = malloc(100);
    
    char *str2;
    {
        char *nested = malloc(100);
        
        if (some_condition) {
            { free(nested); nested = ((void*)0); } { free(str1); str1 = ((void*)0); } { free(str2); str2 = ((void*)0); } return 1;
        }
    { free(nested); nested = ((void*)0); } }
    str2 = malloc(100);
    
    { free(str1); str1 = ((void*)0); } { free(str2); str2 = ((void*)0); } return 0;
{ free(str1); str1 = ((void*)0); } { free(str2); str2 = ((void*)0); } }