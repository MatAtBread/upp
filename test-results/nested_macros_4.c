/* upp examples/nested_macros_4.c */

static int expanded_inner;


int main() {
    /* @outer @inner */ /* @inner */ expanded_inner;
    return 0;
}

