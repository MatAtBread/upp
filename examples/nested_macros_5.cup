#include "io-lite.h"

static int expanded_inner = 5;

@define inner(y) {
    return upp.code`expanded_inner + ${y}`;
}

@define outer(x) {
    return upp.code`${upp.consume()} + ${x}`;
}

int main() {
    int n = @outer(20) @inner(10);
    printf("%d\n", n);
    return 0;
}
