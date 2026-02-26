1. Re-implement hoist so it inserts just above the first function definition.
2. Re-implement Create and Defer for methodical structs.
3. Determine test coverage. Mark any code path that is not exercised and make it throw an exception. If it is not reachable, mark it as dead code and comment it out.
4. Consider eliminating SourceNode.tree as a data member, and make it a getter that walks up the parent chain until it reaches the root translation_unit node.
5. Examine defref.cup. It appears to not find references to the typedef.