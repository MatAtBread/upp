typedef struct String String;
struct String {
    char *data;
};
void _String_method_Defer(String *s) {
    printf("Freeing string: %s\n", s->data);
    free(s->data);
} 
int main() {
    String s1;
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");
    int some_condition = 0;
    if (some_condition) {
        return 1;
    }
    return 0;
}