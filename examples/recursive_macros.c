#include "io-lite.h"
#include "../std/method.hup"
#include "../std/defer.hup"

int some_condition = 1;

struct String {
    char *data;
};
typedef struct String String;

@method(String) void print(String *s) {
    printf("%s\n", s->data);
}

@method(String) void Defer(String *s) {
    s->print();
    free(s->data);
}

int main() {
    String s1;
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");

    if (some_condition) {
        return 0;
    }

    return 1;
}
