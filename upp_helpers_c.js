import { UppHelpersBase } from './upp_helpers_base.js';

/**
 * C-specific helper class extending basic macro functionality.
 * @class
 * @extends UppHelpersBase
 */
class UppHelpersC extends UppHelpersBase {
    /**
     * Resolves the definition of a given identifier node.
     * @param {import('tree-sitter').SyntaxNode} node - The identifier node (identifier, type_identifier, or field_identifier).
     * @returns {import('tree-sitter').SyntaxNode|null} The definition node (e.g., declaration, function_definition) or null.
     */
    getDefinition(node) {
        if (!node) return null;
        const name = node.text;
        const validTypes = ['identifier', 'type_identifier', 'field_identifier'];
        if (!validTypes.includes(node.type)) return null;

        let current = node.parent;
        while (current) {
            if (this._isScopeProvider(current)) {
                const def = this._findDeclarationInScope(current, name, node.type);
                if (def) {
                    return def;
                }
            }
            current = current.parent;
        }
        return null;
    }

    /**
     * Finds all references to a given symbol node.
     * @param {import('tree-sitter').SyntaxNode} node - The symbol node to search references for.
     * @returns {Array<import('tree-sitter').SyntaxNode>} An array of referencing nodes.
     */
    findReferences(node) {
        if (!node) return [];

        let targetId = node;
        const validTypes = ['identifier', 'type_identifier', 'field_identifier'];
        if (!validTypes.includes(node.type)) {
            // Find the first valid identifier type in the declaration
            this.walk(node, (n) => {
                if (targetId === node && validTypes.includes(n.type) && this._isDeclaration(n)) {
                    targetId = n;
                }
            });
        }

        const def = (targetId === node || this._isDeclaration(targetId)) ? targetId : this.getDefinition(targetId);
        if (!def) return [];

        const scope = this._getDefinitionScope(def);
        if (!scope) return [];

        const name = def.text;
        const refs = [];
        this.walk(scope, (n) => {
            if (validTypes.includes(n.type) && n.text === name) {
                if (n.startIndex === def.startIndex && n.endIndex === def.endIndex) {
                    refs.push(n);
                } else {
                    const nDef = this.getDefinition(n);
                    if (nDef) {
                        if (nDef.startIndex === def.startIndex && nDef.endIndex === def.endIndex) {
                            refs.push(n);
                        }
                    }
                }
            }
        });

        // console.log(`DEBUG: findReferences found ${refs.length} refs`);
        return refs;
    }

    /**
     * Checks if a node provides a scope boundary.
     * @private
     * @param {import('tree-sitter').SyntaxNode} node - The node to check.
     * @returns {boolean} True if the node is a scope provider.
     */
    _isScopeProvider(node) {
        return ['compound_statement', 'function_definition', 'translation_unit', 'parameter_list'].includes(node.type);
    }

    /**
     * Determines the scope where a definition is visible.
     * @private
     * @param {import('tree-sitter').SyntaxNode} defNode - The definition definition node.
     * @returns {import('tree-sitter').SyntaxNode} The scope node.
     */
    _getDefinitionScope(defNode) {
        // If it's a parameter, the scope is the function body
        if (defNode.parent && defNode.parent.type === 'parameter_declaration') {
            const func = this.findEnclosing(defNode, 'function_definition');
            return func ? func.childForFieldName('body') : this.root;
        }

        let current = defNode.parent;
        while (current) {
            if (this._isScopeProvider(current)) {
                // Special case: if we found a function_definition, but the identifier
                // is the function name itself, then the scope of this identifier is
                // actually the parent of the function_definition.
                if (current.type === 'function_definition') {
                    const declarator = current.childForFieldName('declarator');
                    if (this.isDescendant(declarator, defNode)) {
                        current = current.parent;
                        continue;
                    }
                }
                return current;
            }
            current = current.parent;
        }
        return this.root;
    }


    /**
     * Checks if a node represents a declaration.
     * @private
     * @param {import('tree-sitter').SyntaxNode} node - The node to check.
     * @returns {boolean} True if the node is a declaration.
     */
    _isDeclaration(node) {
        if (!node) return false;
        const type = node.type;
        const validTypes = ['identifier', 'type_identifier', 'field_identifier'];
        if (!validTypes.includes(type)) return false;

        let p = node.parent;
        while (p && !this._isScopeProvider(p)) {
            if (type === 'identifier') {
                if (p.type === 'function_declarator') {
                    const decl = p.childForFieldName('declarator');
                    if (decl && decl.startIndex === node.startIndex && decl.endIndex === node.endIndex) return true;
                }
                if (p.type === 'init_declarator' && p.childForFieldName('declarator') === node) return true;
                if (p.type === 'parameter_declaration' && p.childForFieldName('declarator') === node) return true;
                if (p.type === 'pointer_declarator' && p.childForFieldName('declarator') === node) {
                    return true;
                }
            }
            if (type === 'type_identifier') {
                if (p.type === 'type_definition' && p.childForFieldName('declarator') === node) return true;
                if (p.type === 'struct_specifier' && p.childForFieldName('name') === node && p.childForFieldName('body')) return true;
            }
            if (type === 'field_identifier') {
                if (p.type === 'field_declaration' && p.childForFieldName('declarator') === node) return true;
            }
            p = p.parent;
        }
        return false;
    }

    /**
     * Searches for a declaration in a specific scope.
     * @private
     * @param {import('tree-sitter').SyntaxNode} scope - The scope node.
     * @param {string} name - The name to search for.
     * @param {string} typeGuess - The expected identifier type.
     * @returns {import('tree-sitter').SyntaxNode|null} The declaration node or null.
     */
    _findDeclarationInScope(scope, name, typeGuess) {
        let found = null;
        this.walk(scope, (n) => {
            if (found) return;
            const validTypes = ['identifier', 'type_identifier', 'field_identifier'];
            if (validTypes.includes(n.type) && n.text === name && this._isDeclaration(n)) {
                // If it's in a sub-scope, ignore it unless it's the target scope itself
                let s = n.parent;
                while (s && s !== scope) {
                    if (this._isScopeProvider(s)) {
                        // Special case: if n is a function name, the function_definition
                        // that contains it is its scope provider, but n actually
                        // belongs to the parent of that function_definition.
                        if (s.type === 'function_definition') {
                            const decl = s.childForFieldName('declarator');
                            if (this.isDescendant(decl, n)) {
                                s = s.parent;
                                continue;
                            }
                        }
                        return; // Shadows or in a sub-scope
                    }
                    s = s.parent;
                }

                // Namespace check: pointers/ordinary vs tags
                // In our macro system, field_identifiers and identifiers share the same namespace
                // for method-style calls to resolve to global functions.
                if (typeGuess === 'type_identifier') {
                    if (n.type === 'type_identifier') found = n;
                } else {
                    if (n.type === 'identifier' || n.type === 'field_identifier') found = n;
                }
            }
        });
        return found;
    }
    /**
     * Hoists code to the top of the file, respecting include directives.
     * @param {string} content - The code to hoist.
     */
    hoist(content) {
        let hoistIndex = 0;
        const root = this.root;

        for (let i = 0; i < root.childCount; i++) {
            const child = root.child(i);
            if (child.type === 'comment' || child.type.startsWith('preproc_')) {
                 if (child.endIndex > hoistIndex) {
                     hoistIndex = child.endIndex;
                 }
            } else if (child.type.trim() === '' || child.type === 'ERROR') {
                 // skip
            } else {
                 if (child.startIndex > hoistIndex) break;
            }
        }

        // Ensure we prepend a newline if needed
        this.replace({start: hoistIndex, end: hoistIndex}, "\n" + content);
    }

    /**
     * extracts the C type string from a definition node.
     * @param {import('tree-sitter').SyntaxNode} defNode - The definition identifier node.
     * @returns {string} The C type string (e.g. "char *").
     */
    getType(defNode) {
        let decl = defNode.parent;
        let suffix = "";

        while (decl) {
             if (decl.type === 'pointer_declarator') {
                 suffix = "*" + suffix;
             }
             if (decl.type === 'array_declarator') {
                 suffix = "[]" + suffix;
             }

             if (decl.type === 'declaration' || decl.type === 'parameter_declaration' || decl.type === 'field_declaration') {
                 break;
             }
             decl = decl.parent;
        }

        if (!decl) return "void *"; // fallback

        let prefix = "";
        for (let i = 0; i < decl.childCount; i++) {
             const c = decl.child(i);
             if (c.type === 'type_qualifier' || c.type === 'storage_class_specifier') {
                  prefix += c.text + " ";
             }
        }

        const typeNode = decl.childForFieldName('type');
        let typeText = typeNode ? typeNode.text : "void";

        return (prefix + typeText + " " + suffix).trim();
    }

    /**
     * Extracts function signature details.
     * @param {import('tree-sitter').SyntaxNode} fnNode - The function_definition node.
     * @returns {{returnType: string, name: string, params: string}} Signature details.
     */
    getFunctionSignature(fnNode) {
        const declarator = fnNode.childForFieldName('declarator');
        // Handle pointer declarators if needed (e.g. char *fn())
        // Simplification: assume direct function_declarator or pointer_declarator -> function_declarator

        let funcDecl = declarator;
        while (funcDecl.type === 'pointer_declarator') { // unwind pointers? No, name is inside.
            funcDecl = funcDecl.childForFieldName('declarator');
        }

        const nameNode = funcDecl.childForFieldName('declarator'); // identifier
        const name = nameNode ? nameNode.text : "unknown";

        const paramList = funcDecl.childForFieldName('parameters');
        let params = "";
        if (paramList) {
             params = paramList.text; // "(int a, char b)"
        }

        const typeNode = fnNode.childForFieldName('type');
        const returnType = typeNode ? typeNode.text : "void";

        return { returnType, name, params };
    }

}

export { UppHelpersC };
