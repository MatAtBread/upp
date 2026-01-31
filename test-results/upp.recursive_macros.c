
/* examples/upp.recursive_macros.c */


/* examples/recursive_macros.c */





struct String {
    char *data;
};

/* @method(String) */  void /* Defer */ _String_method_Defer(String *s) {
    printf("Freeing string: %s\n", s->data);
    free(s->data);
}

int main() {
    String s1; /* @defer /* s1.Defer(); * / */  
    s1.data = malloc(100);
    strcpy(s1.data, "Hello");

    if (some_condition) {
        /* s1.Defer() */ _String_method_Defer(&(s1)); /* s1.Defer(); */ return 1;
    }

    /* s1.Defer() */ _String_method_Defer(&(s1)); /* s1.Defer(); */ return 0;
}


