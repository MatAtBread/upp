1. Ensure upp.code maintains referential stability if the code contains nodes. This should be done by generating identifier names to replace the nodes during the parse phase, and then walking the tree to replace the identifiers with the nodes. The result should be the tree with node references maintained, not text.
2. Re-implement Create and Defer for methodical structs.
3. Update JS Doctypes. Make SourceNode generic, with a parameter that represents the type of the node. This should be used to generate the correct type for the node.
4. Determine test coverage. Mark any code path that is not exercised and make it throw an exception. If it is not reachable, mark it as dead code and comment it out.
5. Consider eliminating SourceNode.tree as a data member, and make it a getter that walks up the parent chain until it reaches the root translation_unit node.
