extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "method.h"
#include "defer.h"
int some_condition = 1;
struct String {
    char *data;
};
typedef struct String String;
void _String_method_print(String *s) {
    printf("%s\n", s->data);
} 
void _String_method_Defer(String *s) {
    _String_method_print(s);
    free(s->data);
} 
int main() {
    String s1; 
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");
    if (some_condition) {
        _String_method_Defer(&(s1)); return 0;
    }
    _String_method_Defer(&(s1)); return 1;
}
