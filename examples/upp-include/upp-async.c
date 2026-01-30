#include "upp-async.h"

void hello() {
    printf("World\n");
}

@async void afn() {
    printf("World\n");
}

int main() {
    @task hello();
    afn();
    return 0;
}
