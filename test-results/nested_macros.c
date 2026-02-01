/* upp examples/nested_macros.c */

static int expanded_inner = 1;


int main() {
    /* @outer */ /* @inner */ expanded_inner;;
    return 0;
}

