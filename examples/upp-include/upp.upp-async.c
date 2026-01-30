/* Sub Pre-upp */
#include "upp-async.h"

void hello() {
    printf("World\n");
}

@async void afn() {
    printf("World\n");
}

// Should error
@async long x;

int main() {
    @task hello();
    afn();

    // Should error
    @task hello;
    return 0;
}
