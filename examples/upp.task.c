
/* examples/task.c */



void hello() {
    printf("World\n");
}

void os_start(void (*task)()) {
    task();
}

int main() {
    /* @task hello(); */ os_start(hello);
    return 0;
}

