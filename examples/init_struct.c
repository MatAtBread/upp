extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
#include "method.h"
typedef struct {
    int x;
    int y;
} Point;

void _Point_method_print(Point *p) {
    printf("Point(%d, %d)\n", p->x, p->y);
} 
void _Point_method_Create(Point *p) {
    printf("Point created(%d, %d)\n", p->x, p->y);
} 
int main() {
    @useCreate(Point)p;
    @useCreate(Point)q = { .x = 5, .y = 9 };
    p.print();
    q.print();
    return 0;
}
