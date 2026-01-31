/* upp examples/refptr.c */



struct Foo;
void _Foo_method_Defer(struct Foo *f);

typedef struct {
    struct Foo *ptr;
    int *count;
} RefPtr_Foo;
void _retain_Foo(RefPtr_Foo p) {

    if (p.count) {
        (*p.count)++;
    }
}
void _release_Foo(RefPtr_Foo p) {

    if (p.count) {
        (*p.count)--;
        if (*p.count == 0) {
             _Foo_method_Defer(p.ptr);
             free(p.count);
             free(p.ptr);
        }
    }
}
RefPtr_Foo _wrap_Foo(struct Foo *ptr) {

    int *count = malloc(sizeof(int));
    *count = 1;
    return (RefPtr_Foo){ ptr, count };
}
RefPtr_Foo _copy_Foo(RefPtr_Foo p) {
    _retain_Foo(p);
    return p;
}
RefPtr_Foo _assign_wrap_Foo(RefPtr_Foo *lhs, struct Foo *rhs_ptr) {
    _release_Foo(*lhs);
    *lhs = _wrap_Foo(rhs_ptr);
    return *lhs;
}
RefPtr_Foo _assign_copy_Foo(RefPtr_Foo *lhs, RefPtr_Foo rhs_val) {
    if (lhs->ptr != rhs_val.ptr) {
        _retain_Foo(rhs_val);
        _release_Foo(*lhs);
        *lhs = rhs_val;
    }
    return *lhs;
}


struct Node;
void _Node_method_Defer(struct Node *f);

void _Node_method_Retain(struct Node *p);
void _Node_method_Release(struct Node *p);

typedef struct {
    struct Node *ptr;
} RefPtr_Node;
void _retain_Node(RefPtr_Node p) {

    if (p.ptr) {
        _Node_method_Retain(p.ptr);
    }
}
void _release_Node(RefPtr_Node p) {

    if (p.ptr) {
        _Node_method_Release(p.ptr);
    }
}
RefPtr_Node _wrap_Node(struct Node *ptr) {

    return (RefPtr_Node){ ptr };
}
RefPtr_Node _copy_Node(RefPtr_Node p) {
    _retain_Node(p);
    return p;
}
RefPtr_Node _assign_wrap_Node(RefPtr_Node *lhs, struct Node *rhs_ptr) {
    _release_Node(*lhs);
    *lhs = _wrap_Node(rhs_ptr);
    return *lhs;
}
RefPtr_Node _assign_copy_Node(RefPtr_Node *lhs, RefPtr_Node rhs_val) {
    if (lhs->ptr != rhs_val.ptr) {
        _retain_Node(rhs_val);
        _release_Node(*lhs);
        *lhs = rhs_val;
    }
    return *lhs;
}
extern int puts (const char *s);
extern int printf (const char *format, ...);
extern void *malloc(int n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);



struct Foo {
    int id;
};
struct Node {
    int value;
    int ref_count;
};
/* @RefRetain(struct Node) */ void _Node_method_Retain(struct Node *p) {
    if (p) {
        p->ref_count++;
    }
}
/* @RefRelease(struct Node) */ void _Node_method_Release(struct Node *p) {
    if (p) {
        p->ref_count--;
        if (p->ref_count == 0) {
            free(p);
        }
    }
}
struct Node* _Node_method_Create() {
    struct Node* n = calloc(1, sizeof(struct Node));
    n->ref_count = 1;
    return n;
}
                          void _Foo_method_Defer(struct Foo *f) {
    if (f) printf("Defer Foo: %d\n", f->id);
}
struct Foo* _Foo_method_Create() {
    printf("Foo Created via Method!\n");
    struct Foo* f = malloc(sizeof(struct Foo));
    f->id = 999;
    return f;
}
int main() {
    printf("Scope 1 Start\n");
    {
        /* @RefPtr(struct Foo) */ RefPtr_Foo p1 = /* malloc(sizeof(struct Foo)) */ _Generic((malloc(sizeof(struct Foo))), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(malloc(sizeof(struct Foo)));
        /* p1 */ p1.ptr->id = 1;
        printf("  p1 id: %d\n", /* p1 */ p1.ptr->id);
        {
            printf("  Scope 2 Start\n");
            /* @RefPtr(struct Foo) */ RefPtr_Foo p2 = /* p1 */ _Generic((p1), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(p1);
            printf("  p2 id: %d\n", /* p2 */ p2.ptr->id);
            /* @RefPtr(struct Foo) */ RefPtr_Foo /* p3 */ p3 = _Generic((_Foo_method_Create()), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(_Foo_method_Create());
            printf("  p3 id: %d\n", /* p3 */ p3.ptr->id);
            /* p3 = p2 */ _Generic((p2), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p3, p2);
            printf("  p3 assigned from p2, id: %d\n", /* p3 */ p3.ptr->id);
            /* @RefPtr(struct Foo) */ RefPtr_Foo /* p4 */ p4 = _Generic((_Foo_method_Create()), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(_Foo_method_Create());
            /* p4 = malloc(sizeof(struct Foo)) */ _Generic((malloc(sizeof(struct Foo))), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p4, malloc(sizeof(struct Foo)));
            /* p4 */ p4.ptr->id = 4;
            printf("  p4 id: %d\n", /* p4 */ p4.ptr->id);
        _release_Foo(p2); _release_Foo(p3); _release_Foo(p4); }
        printf("  Scope 2 End\n");
    _release_Foo(p1); }
    printf("Scope 1 End\n");
    printf("Scope 3 Start (Intrusive)\n");
    {
        /* @RefPtr(struct Node) */ RefPtr_Node /* n1 */ n1 = _Generic((_Node_method_Create()), struct Node*: _wrap_Node, void*: _wrap_Node, RefPtr_Node: _copy_Node)(_Node_method_Create());
        /* n1 */ n1.ptr->value = 10;
        printf("  n1 value: %d\n", /* n1 */ n1.ptr->value);
        /* @RefPtr(struct Node) */ RefPtr_Node n2 = /* n1 */ _Generic((n1), struct Node*: _wrap_Node, void*: _wrap_Node, RefPtr_Node: _copy_Node)(n1);
        printf("  n2 shares n1. RefCount: %d\n", /* n1 */ n1.ptr->ref_count);
    _release_Node(n1); _release_Node(n2); }
    printf("Scope 3 End\n");
    return 0;
}

