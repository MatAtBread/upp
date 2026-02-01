/* upp examples/task.c */


void hello() {
    printf("World\n");
}
void os_start(typeof(hello) task) {
    task();
}
int main() {
    /* @task hello(); */ os_start(hello);
    return 0;
}

