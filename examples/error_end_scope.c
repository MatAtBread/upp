extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
int some_condition = 0;
int main() { 
 int ret_0;
    char *str1 = malloc(100);
    
    char *str2;
    {
        char *nested = malloc(100);
        
        if (some_condition) {
            return 1;
        }
    }
    str2 = malloc(100);
    
    { ret_0 = 0; goto return_main_1_1; }

return_main_1_2:
 { free(str2); str2 = ((void*)0); }
return_main_1_1:
 { free(nested); nested = ((void*)0); }
return_main_1_0:
 { free(str1); str1 = ((void*)0); }
 return ret_0;
}