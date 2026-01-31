/* upp examples/init_struct.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);


typedef struct {
    int x;
    int y;
} Point;

/* @method(Point) void print(Point *p) {
    printf("Point(%d, %d)\n", p->x, p->y);
}
@method(Point) void Create(Point *p) {
    printf("Point created(%d, %d)\n", p->x, p->y);
} */ void _Point_method_print(Point *p) {
    printf("Point(%d, %d)\n", p->x, p->y);
} 
void _Point_method_Create(Point *p) {
    printf("Point created(%d, %d)\n", p->x, p->y);
} 
int main() {
    /* @Point  */ /* @useCreate(Point)p; */ Point p = {0}; /* p.Create() */ _Point_method_Create(&(p));
    /* @Point  */ /* @useCreate(Point)q = { .x = 5, .y = 9 }; */ Point q  = { .x = 5, .y = 9 }; /* q.Create() */ _Point_method_Create(&(q));
    /* p.print() */ _Point_method_print(&(p));
    /* q.print() */ _Point_method_print(&(q));
    return 0;
}

