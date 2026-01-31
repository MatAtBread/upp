
/* examples/upp.map.c */


/* examples/map.c */



int main() {
    int arr[] = {1, 2, 3};
    /* @map arr z { z = z + 1; } */ 
    for (int _i = 0; _i < sizeof(arr)/sizeof(arr[0]); _i++) {
        int z = arr[_i];
        { z = z + 1; }
        arr[_i] = z;
    };
    return 0;
}



