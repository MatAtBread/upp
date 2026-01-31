
/* examples/upp.fieldsof.c */


/* examples/fieldsof.c */

#include <stdio.h>



struct Base {
    int x;
    int y;
};

// Typedef example
typedef struct {
    float lat;
    float lon;
} GeoCoord;

struct Derived {
    int z;
    /* @fieldsof(struct Base); */ int x;
    int y;
     // Standard struct tag
    /* @fieldsof(GeoCoord); */ float lat;
    float lon;
        // Typedef
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


