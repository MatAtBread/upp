/* upp examples/end_scope_2.c */


extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
int some_condition = 0;
int main() { 
 int ret_0;
    char *str1 = malloc(100);
    /* @defer { free(str1); str1 = ((void*)0); } */ 
    char *str2;
    {
        char *nested = malloc(100);
        /* @defer { free(nested); nested = ((void*)0); } */ 
        if (some_condition) {
            /* return 1; */ { ret_0 = 1; goto return_main_1_1; }
        }
    }
    str2 = malloc(100);
    /* @defer { free(str2); str2 = ((void*)0); }
    return 0;
 */ 
    { ret_0 = 0; goto return_main_1_2; }

return_main_1_2:
 { free(str2); str2 = ((void*)0); }
return_main_1_1:
 { free(nested); nested = ((void*)0); }
return_main_1_0:
 { free(str1); str1 = ((void*)0); }
 return ret_0;
}

