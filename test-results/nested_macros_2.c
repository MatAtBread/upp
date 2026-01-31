/* upp examples/nested_macros_2.c */

int expanded_inner;


int main() {
    /* @outer */ /* @inner */ expanded_inner;
    return 0;
}

