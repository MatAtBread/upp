extern int puts (const char *s);
extern int printf (const char *format, ...);
extern int fputs (const char *s, void *stream);
extern void* stderr;
extern void *malloc(unsigned long n);
extern void free(void *p);
extern char *strcpy(char *dest, const char *src);
                   
                            
                                         
                                            
     
                                             
                              
                                
     
                                                  
                        
                         
         
                                                                 
                                                                                                                                        
                                                                             
                                                 
                                                       
                                                         
                                               
                                                    
                                       
                                                                                         
                                                
                 
                             
               
         
                     
      
                                                   
                                                     
                                  
                                                    
                          
              
               
  
                          
                           
              
  
         
                          
                  
                     
     
  
                           
                  
                     
                            
                                              
                           
                         
         
     
  
                        
                                     
               
                                          
  
                          
                          
                
                                          
     
  
                             
                               
                
                                           
     
  
                    
                                  
             
                        
                                   
  
         
                            
                   
                                        
                 
                                         
                                          
       
                                              
                                            
              
                                             
               
                                             
            
                                                    
                           
             
 
                                                                             
                               
                                      
                
 
                                                                                      
                                  
                                     
                                   
                       
     
                
 
  
                              
                                                        
     
                                                    
                                                  
                 
                                                        
                                       
                                                        
                          
                                                             
                                   
                                                                                     
                                  
                                                                                                     
                                                        
                                           
                              
                          
                                 
                      
                  
                                                                                                                                       
                                             
                                           
                                        
                                                                     
                                                      
                                                     
                                                         
                                                       
                                                                              
                                 
                                                                                                              
                                             
                                                                 
                                
                                                            
                         
                     
                                                        
                                            
                                                      
                                                            
                                                                                        
                                
                                                                                      
                                                    
                                                                               
                                           
                                                                          
                                                                                                        
                                                                                  
                                                            
                                           
                                  
                                                                  
                              
                         
                                                     
                                                                         
                         
                                                                                                                                                               
                                                           
                                                                                                                             
                                                       
                                      
                             
                         
                                               
                                                                
                                                                                                                 
                         
                                                                                        
                                                    
                                                                                    
                                                                                         
                                                                                                       
                                                                                                                   
                                                           
                                                                               
                                                           
                                 
                                                                                                                             
                                                           
                                 
                                                     
                                              
                                 
                                                                                   
                                                      
                                                                                                                                 
                                                     
                                 
                                                 
                                                                                                                                                                
                                 
                             
                         
                     
                                                      
                                                                                                                                                                                       
                      
                                 
                                        
                                                                               
                                                                    
                          
                                                                                                              
                                                   
                                                            
                          
                                                                                                                                    
                                                                                          
                         
                            
                                                                                
                                                                                                           
                                                           
                                                                                                                            
                                                      
                                                                                           
                             
                                         
                           
                                       
                                                                      
                                                                                                                   
                                
                                                                                                                                                       
                         
                     
                 
             
                                                                                                                                 
                                      
                                                                
                                                     
                                              
                                                             
                                                            
                                                             
                                                          
                                                                        
                                                                              
                                      
                          
                      
                                                                                                                                                                                                                                        
                                                                                       
                 
             
                                                                                                                                                        
                                          
                                                             
                                                    
                                              
                                                                                   
                 
             
                                                                                                            
                                     
                                                              
                                              
                                                                        
                                                      
                                                     
                                               
                                                                                   
                  
             
                           
             
           
                                                        
     
                       
 
                      
                            
                                                                            
                                                      
 
                       
                            
                                                                            
                                                       
 
struct Foo {
    int id;
};
struct Node {
    int value;
    int ref_count;
};
void _Node_method_Retain(struct Node *p) {
    if (p) {
        p->ref_count++;
    }
}
void _Node_method_Release(struct Node *p) {
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
        RefPtr_Foo p1 = _Generic((malloc(sizeof(struct Foo))), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(malloc(sizeof(struct Foo)));
        p1.ptr->id = 1;
        printf("  p1 id: %d\n", p1.ptr->id);
        {
            printf("  Scope 2 Start\n");
            RefPtr_Foo p2 = _Generic((p1), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(p1);
            printf("  p2 id: %d\n", p2.ptr->id);
            RefPtr_Foo p3 = _Generic((_Foo_method_Create()), struct Foo*: _wrap_Foo, void*: _wrap_Foo, RefPtr_Foo: _copy_Foo)(_Foo_method_Create());
            printf("  p3 id: %d\n", p3.ptr->id);
            _Generic((p2), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p3, p2);
            printf("  p3 assigned from p2, id: %d\n", p3.ptr->id);
            RefPtr_Foo p4;
            _Generic((malloc(sizeof(struct Foo))), struct Foo*: _assign_wrap_Foo, void*: _assign_wrap_Foo, RefPtr_Foo: _assign_copy_Foo)(&p4, malloc(sizeof(struct Foo)));
            p4.ptr->id = 4;
            printf("  p4 id: %d\n", p4.ptr->id);
        _release_Foo(p4); _release_Foo(p3); _release_Foo(p2); }
        printf("  Scope 2 End\n");
    _release_Foo(p1); }
    printf("Scope 1 End\n");
    printf("Scope 3 Start (Intrusive)\n");
    {
        RefPtr_Node n1;
        n1.ptr->value = 10;
        printf("  n1 value: %d\n", n1.ptr->value);
        RefPtr_Node n2 = n1;
        printf("  n2 shares n1. RefCount: %d\n", n1.ptr->ref_count);
    _release_Node(n2); _release_Node(n1); }
    printf("Scope 3 End\n");
    return 0;
}