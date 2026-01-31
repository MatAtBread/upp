
/* examples/upp.consume_rename.c */


/* examples/consume_rename.c */





// 1. Using context (Safe, recommended for refactoring)
/* @rename_context(y_ctx) */ 
int /* x_ctx */ y_ctx = 10;

void test_ctx() {
    /* x_ctx */ y_ctx = 20;
}

// 2. Using consume (Requires manual reconstruction)
/* @rename_consume(y_cons)
int x_cons = 100; */ int y_cons = 100;


void test_cons() {
    /* x_cons */ y_cons = 200;
}

int main() {
    return 0;
}


