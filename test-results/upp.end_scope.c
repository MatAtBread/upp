
/* examples/upp.end_scope.c */


/* examples/end_scope.c */



int main() {
    char *str1 = malloc(100);
    /* @defer { free(str1); str1 = NULL; } */ 
    char *str2;

    {
        char *nested = malloc(100);
        /* @defer { free(nested); nested = NULL; } */ 
        if (some_condition) {
            // should defer here, str1
            { free(str1); str1 = NULL; } { free(nested); nested = NULL; } return 1;
        }
    { free(nested); nested = NULL; } }
    str2 = malloc(100);
    /* @defer { free(str2); str2 = NULL; } */ 

    // should defer here, str2 then str1
    { free(str1); str1 = NULL; } { free(str2); str2 = NULL; } return 0;
}


