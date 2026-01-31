/* upp examples/async.c */


extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
void os_start(void (*fn)()) {
    puts("Run in background");
    fn();
    puts("Finished");
}
/* @async  */ void afn() {
    printf("World\n");
}
int main() {
    /* afn() */ os_start(afn);
    return 0;
}

