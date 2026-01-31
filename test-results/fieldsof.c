/* upp examples/fieldsof.c */

extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);

struct Base {
    int x;
    int y;
};
typedef struct {
    float lat;
    float lon;
} GeoCoord;
struct Derived {
    int z;
    /* @fieldsof(struct Base);
    @fieldsof(GeoCoord); */ int x;
    int y;
    
    float lat;
    float lon;
    
};
int main() {
    struct Derived d;
    d.x = 10;
    d.y = 20;
    d.z = 30;
    d.lat = 51.5f;
    d.lon = -0.1f;
    printf("Derived: x=%d, y=%d, z=%d, lat=%.1f, lon=%.1f\n", d.x, d.y, d.z, d.lat, d.lon);
    return 0;
}

