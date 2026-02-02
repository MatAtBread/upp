/* upp examples/import.c */


/* @import(io) "io-lite.h";
@import(str) "string.h"; */ 
#include "io-lite.h" 

#include "string.h" 
int main() {
    /* io.printf */ printf("Hello, World!\n");
    /* str.strlen */ strlen("Hello");
    return 0;
}

