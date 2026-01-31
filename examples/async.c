#include "../std/async.h"

@async void afn() {
    printf("World\n");
}

int main() {
    afn();
    return 0;
}
