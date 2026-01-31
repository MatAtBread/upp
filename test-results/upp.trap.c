
/* examples/upp.trap.c */


/* examples/trap.c */


int x_trap_0(int value) { return value * 2; }
int z_trap_1(int value) { return value + 1; }

int my_logger(int v) {
    printf("Logging value: %d\n", v);
    return v;
}

struct Point {
    /* @trap({ return value * 2; }) int x;
    @trap(my_logger) int y; */ int x; 
    int y; 
};

int main() {
    struct Point p;
    p.x = /* 10 */ x_trap_0(10); // x = trap(10) -> 20
    p.y = /* 5 */ my_logger(5);  // y = logger(5) -> 5, prints "Logging value: 5"

    /* @trap({ return value + 1; }) int z = 10; */ int z = z_trap_1(10);  // z = trap(10) -> 11
    z = /* 20 */ z_trap_1(20); // z = trap(20) -> 21

    printf("p.x=%d, p.y=%d, z=%d\n", p.x, p.y, z);
    return 0;
}


