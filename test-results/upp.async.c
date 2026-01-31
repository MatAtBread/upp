
/* examples/upp.async.c */


/* examples/async.c */



/* @async  */ void afn() {
    printf("World\n");
}

int main() {
    /* afn() */ os_start(afn);
    return 0;
}


