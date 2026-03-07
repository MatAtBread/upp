1. Hide node.insert* (+ other modifiers) with upp.helpers to automagically call revisit
2. Re-implement hoist so it inserts just above the first function definition.
3. Re-implement Create and Defer for methodical structs.
4. Determine test coverage. Mark any code path that is not exercised and make it throw an exception. If it is not reachable, mark it as dead code and comment it out.
5. Allow aliases for @method, eg `@method(type) reference_count = <function_identifier>`. This would save duplication of code for example in managed-struct.hup
6. Generalise "marker" nodes & comments to be language independent. Remove any `type` tests from everywhere except upp_helpers_c