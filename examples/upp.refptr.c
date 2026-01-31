
/* examples/refptr.c */


#include <stdio.h>
#include <stdlib.h>







// ----------------------------------------------------
// Testing Code
// ----------------------------------------------------

// Forward declaration of Type
struct Foo;

// Forward declaration of Defer method (convention)
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
    *count = 1; /* Starts at 1 */
    return (RefPtr_Foo){ ptr, count };
}

RefPtr_Foo _copy_Foo(RefPtr_Foo p) {
    _retain_Foo(p);
    return p;
}

// New assign helpers
RefPtr_Foo _assign_wrap_Foo(RefPtr_Foo *lhs, struct Foo *rhs_ptr) {
    _release_Foo(*lhs); // Release old value
    *lhs = _wrap_Foo(rhs_ptr); // Wrap new pointer
    return *lhs;
}

RefPtr_Foo _assign_copy_Foo(RefPtr_Foo *lhs, RefPtr_Foo rhs_val) {
    if (lhs->ptr != rhs_val.ptr) { // Avoid self-assignment issues
        _retain_Foo(rhs_val); // Retain new value
        _release_Foo(*lhs);   // Release old value
        *lhs = rhs_val;               // Assign
    }
    return *lhs;
}



// Forward declaration of Type
struct Node;

// Forward declaration of Defer method (convention)
void _Node_method_Defer(struct Node *f);

// Forward Custom Hooks
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

    // Intrusive wrap: assume ptr has count=1 or we adopt it.
    // Standard RefPtr practice acts as "taking ownership".
    // If wrapping a raw pointer from Create(), it has 1.
    return (RefPtr_Node){ ptr };
}

RefPtr_Node _copy_Node(RefPtr_Node p) {
    _retain_Node(p);
    return p;
}

// New assign helpers
RefPtr_Node _assign_wrap_Node(RefPtr_Node *lhs, struct Node *rhs_ptr) {
    _release_Node(*lhs); // Release old value
    *lhs = _wrap_Node(rhs_ptr); // Wrap new pointer
    return *lhs;
}

RefPtr_Node _assign_copy_Node(RefPtr_Node *lhs, RefPtr_Node rhs_val) {
    if (lhs->ptr != rhs_val.ptr) { // Avoid self-assignment issues
        _retain_Node(rhs_val); // Retain new value
        _release_Node(*lhs);   // Release old value
        *lhs = rhs_val;               // Assign
    }
    return *lhs;
}



struct Foo {
    int id;
};

// ----------------------------------------------------
// Intrusive Test Types
// ----------------------------------------------------
struct Node {
    int value;
    int ref_count;
};

// Intrusive Retain
/* @RefRetain(struct Node) */ void _Node_method_Retain(struct Node *p) {
    if (p) {
        p->ref_count++;
         // printf("Intrusive Retain: %d\n", p->ref_count);
    }
}

// Intrusive Release
/* @RefRelease(struct Node) */ void _Node_method_Release(struct Node *p) {
    if (p) {
        p->ref_count--;
        // printf("Intrusive Release: %d\n", p->ref_count);
        if (p->ref_count == 0) {
            // printf("Intrusive Free\n");
            free(p);
        }
    }
}

// Factory
struct Node* _Node_method_Create() {
    struct Node* n = calloc(1, sizeof(struct Node));
    n->ref_count = 1; // Start with 1
    return n;
}

/* @method(struct Foo) */ void _Foo_method_Defer(struct Foo *f) {
    if (f) printf("Defer Foo: %d\n", f->id);
}

// Custom Create method to test auto-detection
struct Foo* _Foo_method_Create() {
    printf("Foo Created via Method!\n");
    struct Foo* f = malloc(sizeof(struct Foo));
    f->id = 999; // distinctive value
    return f;
}

int main() {
    printf("Scope 1 Start\n");
    {
        // 1. Implicit Init with malloc (void*)
        /* @RefPtr(struct Foo) */ RefPtr_Foo p1 = /* malloc(sizeof(struct Foo)) */ _Generic((malloc(sizeof(struct Foo))), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(malloc(sizeof(struct Foo)));
        /* p1 */ p1.ptr->id = 1; // User requested elision: p->id should work/transform to p.ptr->id
        printf("  p1 id: %d\n", /* p1 */ p1.ptr->id);

        {
            printf("  Scope 2 Start\n");
            // 2. Implicit Copy Init (RefPtr)
            /* @RefPtr(struct Foo) */ RefPtr_Foo p2 = /* p1 */ _Generic((p1), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(p1);
            printf("  p2 id: %d\n", /* p2 */ p2.ptr->id); // Elision

            // 3. Implicit Zero Init (Fallback if no Create, but now we have Create!)
            // WAIT: We just added Create. So this test case behavior CHANGES.
            // Old p3 was zero-init (id=0). New p3 should be id=999.
            /* @RefPtr(struct Foo) */ RefPtr_Foo /* p3 */ p3 = _Generic((_Foo_method_Create()), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(_Foo_method_Create());
            printf("  p3 id: %d\n", /* p3 */ p3.ptr->id);

            // 4. Assignment (RefPtr = RefPtr)
            /* p3 = p2 */ _Generic((p2), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p3, p2); // p3 now shares p1/p2
            printf("  p3 assigned from p2, id: %d\n", /* p3 */ p3.ptr->id);

            // 5. Assignment (RefPtr = malloc)
            /* @RefPtr(struct Foo) */ RefPtr_Foo /* p4 */ p4 = _Generic((_Foo_method_Create()), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(_Foo_method_Create());
            /* p4 = malloc(sizeof(struct Foo)) */ _Generic((malloc(sizeof(struct Foo))), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p4, malloc(sizeof(struct Foo)));
            /* p4 */ p4.ptr->id = 4;
            printf("  p4 id: %d\n", /* p4 */ p4.ptr->id);

        _release_Foo(p2); _release_Foo(p3); _release_Foo(p4); }
        printf("  Scope 2 End\n");
        // p2, p3, p4 released. p1 count should still be valid.
    _release_Foo(p1); }
    printf("Scope 1 End\n");

    printf("Scope 3 Start (Intrusive)\n");
    {
        /* @RefPtr(struct Node) */ RefPtr_Node /* n1 */ n1 = _Generic((_Node_method_Create()), struct Node*: _wrap_Node, void*: _wrap_Node, RefPtr_Node: _copy_Node)(_Node_method_Create()); // Use Create
        /* n1 */ n1.ptr->value = 10;
        printf("  n1 value: %d\n", /* n1 */ n1.ptr->value); // Elision

        /* @RefPtr(struct Node) */ RefPtr_Node n2 = /* n1 */ _Generic((n1), struct Node*: _wrap_Node, void*: _wrap_Node, RefPtr_Node: _copy_Node)(n1);
        printf("  n2 shares n1. RefCount: %d\n", /* n1 */ n1.ptr->ref_count); // Should be 2
    _release_Node(n1); _release_Node(n2); }
    printf("Scope 3 End\n");

    return 0;
}

