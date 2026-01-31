/* upp examples/end_scope.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(int n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);

int some_condition;
int main() {
    char *str1 = malloc(100);
    /* @defer { free(str1); str1 = ((void*)0); } */ 
    char *str2;
    {
        char *nested = malloc(100);
        /* @defer { free(nested); nested = ((void*)0); } */ 
        if (some_condition) {
            { free(str1); str1 = ((void*)0); } { free(nested); nested = ((void*)0); } return 1;
        }
    { free(nested); nested = ((void*)0); } }
    str2 = malloc(100);
    /* @defer { free(str2); str2 = ((void*)0); }
     */ 
    { free(str1); str1 = ((void*)0); } { free(str2); str2 = ((void*)0); } return 0;
}

