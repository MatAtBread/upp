/* upp examples/recursive_macros.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);



int some_condition = 1;
struct String {
    char *data;
};
typedef struct String String;
/* @method(String) void print(String *s) {
    printf("%s\n", s->data);
}
@method(String) void Defer(String *s) {
    s->print();
    free(s->data);
} */ void _String_method_print(String *s) {
    printf("%s\n", s->data);
} 
void _String_method_Defer(String *s) {
    /* s->print() */ _String_method_print(s);
    free(s->data);
} 
int main() {
    /* String s1; */ String s1; /* @defer s1.Defer(); */ 
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");
    if (some_condition) {
        /* s1.Defer() */ _String_method_Defer(&(s1)); return 0;
    }
    /* s1.Defer() */ _String_method_Defer(&(s1)); return 1;
}

