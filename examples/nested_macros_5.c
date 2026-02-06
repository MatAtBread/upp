extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
static int expanded_inner = 5;
                  
                                           
 
                  
                                             
 
int main() {
    int n = expanded_inner + 10 + 20 expanded_inner + 10;
    printf("%d\n", n);
    return 0;
}