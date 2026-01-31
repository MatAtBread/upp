
/* examples/upp.end_scope_2.c */


/* examples/end_scope_2.c */

/*
NB: this macro impl doesn't work. It frees "nested" long after the scope has gone.
 */


int main() { 
    int ret_0;
    char *str1 = malloc(100);
    /* @defer { free(str1); str1 = NULL; } */ 
    char *str2;

    {
        char *nested = malloc(100);
        /* @defer { free(nested); nested = NULL; } */ 
        if (some_condition) {
            // should defer here, str1
            /* return 1; */ { ret_0 = 1; goto return_main_1_1; }
        }
    }
    str2 = malloc(100);
    /* @defer { free(str2); str2 = NULL; } */ 

    // should defer here, str2 then str1
    /* return 0;
 */ { ret_0 = 0; goto return_main_1_2; }

return_main_1_2:
  { free(str2); str2 = NULL; }
return_main_1_1:
  { free(nested); nested = NULL; }
return_main_1_0:
  { free(str1); str1 = NULL; }
  return ret_0;
}


