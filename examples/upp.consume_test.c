
/* examples/consume_test.c */





int main() {
    /* @test_valid
    {
        printf("Block 1\n");
    } */ 
    // Valid cases
    {
        {
        printf("Block 1\n");
    }
        {
        printf("Block 2\n");
    }
        int x = 10;
    }
    // Comment between blocks
    /* {
        printf("Block 2\n");
    }
    int x = 10; */ 
    

    return 0;
}

