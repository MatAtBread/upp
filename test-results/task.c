extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);

void hello() {
    printf("World\n");
}
void os_start(typeof(hello) task) {
    task();
}
int main() {
    os_start(hello);
    return 0;
}
