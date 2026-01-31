
/* examples/upp.forward.c */


/* examples/forward.c */


void foo();
void bar();


/* @forward */ ;

void foo() {
    printf("Foo calls bar\n");
    bar();
}

void bar() {
    printf("Bar called\n");
}

int main() {
    foo();
    return 0;
}


