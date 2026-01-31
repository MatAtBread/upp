#include "../std/async.h"

#include "io-lite.h"

void os_start(void (*fn)()) {
    puts("Run in background");
    fn();
    puts("Finished");
}

@async void afn() {
    printf("World\n");
}

int main() {
    afn();
    return 0;
}
