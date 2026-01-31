
/* examples/find_refs_test.c */



/* @rename(y) */ 
int /* x */ y = 10;

void print_x() {
    printf("Global x: %d\n", /* x */ y);
}

int main() {
    print_x();
    /* x */ y = 20;
    print_x();
    return 0;
}

