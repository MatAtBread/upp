

int y = 10;
void print_x() {
    printf("Global x: %d\n", y);
}
int main() {
    print_x();
    y = 20;
    print_x();
    return 0;
}
