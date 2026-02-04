#include "mypkg.h"
int mypkg_add(int a, int b) {
    return a + b;
}
int mypkg_sub(int a, int b) {
    return mypkg_add(a, -b);
}
static int helper() {
    return 42;
}
int mypkg_use_helper() {
    return helper();
}
