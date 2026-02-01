/* upp examples/map_3.c */


int main() {
    int arr[] = {1, 2, 3, 4};
    /* @map(arr, z) { z = z + 10; } { z = z + 100; } */ 
    for (int _i = 0; _i < sizeof(arr)/sizeof(arr[0]); _i++) {
        int z = arr[_i];
        if (_i % 2 == 0) {
            { z = z + 10; }
        } else {
            { z = z + 100; }
        }
        arr[_i] = z;
    }  ;
    return 0;
}

