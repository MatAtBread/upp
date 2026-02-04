/* @include(mypkg.hup)
int add(int a, int b) {
    return a + b;
}
int sub(int a, int b) {
    return /* add(a, -b) * / mypkg_add(a, -b);
} */ #include "mypkg.h"
int mypkg_add(int a, int b) {
    return a + b;
}
int mypkg_sub(int a, int b) {
    return /* add(a, -b) */ mypkg_add(a, -b);
}
static int helper() {
    return 42;
}
/* int use_helper() {
    return helper();
} */ int mypkg_use_helper() {
    return helper();
}
