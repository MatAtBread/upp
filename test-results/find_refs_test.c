int y = 10;
void print_x() {
    printf("Global x: %d\n", y);
}
void local_rename() {
     int a = 10;
    {
        int b = 40;
    }
    return a;
}
int main() {
    print_x();
    y = 20;
    print_x();
    return 0;
}