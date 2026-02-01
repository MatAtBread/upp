/* upp examples/match_longify.c */


/* @longify(bar)
@longify(baz) */ 

int foo = 100;
/* int bar = 200; */ long bar = 200L;
void f() {
    /* int bar = 4; */ long bar = 4L;
}
int main() {
    /* int bar = 5; */ long bar = 5L;
    /* int baz = 5; */ long baz = 5L;
    return 0;
}

