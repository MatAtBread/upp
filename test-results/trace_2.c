extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "lambda.h"
#include "defer.h"
                 
                                 
                                                                          
                                                       
               
                       
                                 
                                          
                                                                   
                   
                                                                                                     
   
     
 


void _exit_impl_0() { fputs("Exiting: my_function\n", stderr); }
int my_function(int x) {
    fputs("Entering: my_function\n", stderr);
    ;
    
    int g = 1;
	for (int i=1; i < x; i++) {
        g = g * i;
        if (g>100) {
            _exit_impl_0(); return -1;
        }
    }
	_exit_impl_0(); return g;
}
int main() {
    printf("magic number %d\n", my_function(10));
    return 0;
}