
/* examples/upp.task.c */


/* examples/task.c */



void hello() {
    printf("World\n");
}

int main() {
    /* @task hello(); */ os_start(hello);
    return 0;
}


