import { UppHelpersBase } from './upp_helpers_base.ts';
import type { Registry, RegistryContext } from './registry.ts';
import { SourceNode } from './source_tree.ts';
import type { MacroResult, AnySourceNode, InterpolationValue } from './types.ts';

export class FunctionSignature {
  public returnType: string;
  public name: string;
  public params: string;
  public node: SourceNode<CNodeTypes>;
  public nameNode?: SourceNode<CNodeTypes> | null;
  public bodyNode?: SourceNode<CNodeTypes> | null;

  constructor(
    returnType: string,
    name: string,
    params: string,
    node: SourceNode<CNodeTypes>,
    nameNode?: SourceNode<CNodeTypes> | null,
    bodyNode?: SourceNode<CNodeTypes> | null
  ) {
    this.returnType = returnType;
    this.name = name;
    this.params = params;
    this.node = node;
    this.nameNode = nameNode;
    this.bodyNode = bodyNode;
  }
}

export type CNodeTypes =
  | 'translation_unit'
  | 'preproc_include'
  | 'preproc_def'
  | 'preproc_function_def'
  | 'preproc_params'
  | 'preproc_call'
  | 'preproc_if'
  | 'preproc_ifdef'
  | 'preproc_else'
  | 'preproc_arg'
  | 'function_definition'
  | 'declaration'
  | 'type_definition'
  | 'struct_specifier'
  | 'union_specifier'
  | 'enum_specifier'
  | 'enum_specifier_contents'
  | 'enumerator'
  | 'parameter_list'
  | 'parameter_declaration'
  | 'attributable_declarator'
  | 'init_declarator'
  | 'pointer_declarator'
  | 'array_declarator'
  | 'function_declarator'
  | 'parenthesized_declarator'
  | 'identifier'
  | 'field_identifier'
  | 'type_identifier'
  | 'statement_identifier'
  | 'primitive_type'
  | 'sized_type_specifier'
  | 'type_qualifier'
  | 'storage_class_specifier'
  | 'compound_statement'
  | 'expression_statement'
  | 'if_statement'
  | 'while_statement'
  | 'do_statement'
  | 'for_statement'
  | 'return_statement'
  | 'break_statement'
  | 'continue_statement'
  | 'goto_statement'
  | 'switch_statement'
  | 'case_statement'
  | 'labeled_statement'
  | 'field_declaration_list'
  | 'field_declaration'
  | 'assignment_expression'
  | 'binary_expression'
  | 'unary_expression'
  | 'update_expression'
  | 'cast_expression'
  | 'pointer_expression'
  | 'sizeof_expression'
  | 'subscript_expression'
  | 'call_expression'
  | 'argument_list'
  | 'field_expression'
  | 'compound_literal_expression'
  | 'parenthesized_expression'
  | 'comma_expression'
  | 'conditional_expression'
  | 'string_literal'
  | 'number_literal'
  | 'char_literal'
  | 'null'
  | 'true'
  | 'false'
  | 'comment';

/**
 * C-specific helper class.
 * @class
 * @extends UppHelpersBase
 */
export class UppHelpersC extends UppHelpersBase<CNodeTypes> {
  constructor(registry: Registry, parentHelpers: UppHelpersBase<any> | null = null) {
    super(registry, parentHelpers);
  }

  /**
   * Finds the nearest enclosing C scope (compound_statement or translation_unit).
   * @returns {SourceNode<CNodeTypes> | null} The scope node or null.
   */
  findScope(): SourceNode<CNodeTypes> | null {
    const startNode = (this.lastConsumedNode && this.lastConsumedNode.parent) ? this.lastConsumedNode : this.contextNode;
    if (!startNode) return null;

    // 1. Try to find the nearest enclosing block
    const block = this.findEnclosing(startNode, ['compound_statement']);
    if (block) return block;

    // 2. If we are in a function definition but not inside the body (e.g. in parameters), find the body
    const fn = this.findEnclosing(startNode, ['function_definition']);
    if (fn && fn.named.body) return fn.named.body;

    // 3. Fallback to translation unit
    return this.findEnclosing(startNode, ['translation_unit']);
  }

  /**
   * Hoists content to the top of the file, skipping comments.
   * @param {string} content - The content to hoist.
   * @param {number} [_hoistIndex=0] - The index to hoist to.
   */
  hoist(content: string, _hoistIndex: number = 0): void {
    const root = this.root;
    if (!root) throw new Error("helpers.hoist: Invalid root");
    if (root.children.length > 0) {
      root.children[0].insertBefore(content + "\n");
    } else {
      this.replace(root, content + "\n");
    }
  }

  /**
   * extracts the C type string from a definition node.
   * @param {SourceNode<CNodeTypes> | string | null} node - The identifier node or name.
   * @param {{ resolve?: boolean, isCall?: boolean }} [options] - Options for type resolution.
   * @returns {string | SourceNode<CNodeTypes> | null} The C type string (e.g. "char *") or resolved node.
   */
  getType(node: SourceNode<CNodeTypes> | string | null | undefined, options: { resolve?: boolean, isCall?: boolean } = {}, _visited: WeakSet<SourceNode<any>> = new WeakSet()): string | SourceNode<CNodeTypes> | null {
    if (!node) return null;
    let target = typeof node === 'string' ? this.findDefinitionOrNull(node) : node;
    if (!target) return null;

    if (target.type === 'expression_statement') target = target.child(0) as SourceNode<CNodeTypes>;

    // Handle expressions directly
    if (target.type === 'cast_expression') {
      const typeNode = target.named.type;
      return typeNode ? typeNode.text : "void *";
    }
    if (target.type === 'string_literal') return "char *";
    if (target.type === 'char_literal') return "char";
    if (target.type === 'number_literal') {
      const text = target.text;
      if (text.includes('.')) return "double";
      const lower = text.toLowerCase();
      if (lower.endsWith('ull')) return "unsigned long long";
      if (lower.endsWith('ll')) return "long long";
      if (lower.endsWith('ul')) return "unsigned long";
      if (lower.endsWith('l')) return "long";
      if (lower.endsWith('u')) return "unsigned int";
      return "int";
    }

    if (target.type === 'assignment_expression') {
      const left = target.named.left || target.child(0);
      if (left) return this.getType(left, options, _visited);
    }

    if (target.type === 'identifier' || target.type === 'field_identifier') {
      const def = this.findDefinitionOrNull(target);
      if (def && def !== target && !_visited.has(def)) {
        _visited.add(target);
        return this.getType(def, options, _visited);
      }
    }

    if (target.type === 'field_expression') {
      const field = target.named.field || target.child(2);
      if (field) {
        const def = this.findDefinitionOrNull(field);
        if (def && def !== target && !_visited.has(def)) {
          _visited.add(target);
          return this.getType(def, options, _visited);
        }
      }
    }

    if (target.type === 'subscript_expression') {
      const arg = target.named.argument || target.child(0);
      if (arg) {
        const arrayType = this.getType(arg, options, _visited);
        if (typeof arrayType === 'string') {
          if (arrayType.endsWith('[]')) return arrayType.slice(0, -2).trim();
          if (arrayType.includes('*')) return arrayType.replace(/\*\s*$/, '').trim();
          return arrayType;
        }
        return arrayType;
      }
    }

    if (target.type === 'parenthesized_expression') {
      const inner = target.child(1);
      if (inner) return this.getType(inner, options, _visited);
    }

    if (target.type === 'call_expression') {
      const func = target.named.function || target.child(0);
      if (func) {
        // Evaluate the type of the function being called.
        // Evaluate the return type of the function being called.
        return this.getType(func, { ...options, isCall: true }, _visited);
      }
    }

    if (target.type === 'update_expression') {
      const inner = target.named.argument || target.child(0);
      if (inner) return this.getType(inner, options, _visited);
    }

    if (target.type === 'sizeof_expression') {
      return "unsigned long";
    }

    if (target.type === 'unary_expression' || target.type === 'pointer_expression') {
      const operator = target.named.operator?.text || target.child(0)?.text;
      const arg = target.named.argument || target.child(1);
      if (arg) {
        if (operator === '&') {
          const argType = this.getType(arg, options, _visited);
          if (typeof argType === 'string') {
            return `${argType} *`;
          }
          return argType; // if SourceNode, caller has to handle wrapping if resolving address-of struct
        }
        if (operator === '*') {
          const argType = this.getType(arg, options, _visited);
          if (typeof argType === 'string') {
            if (argType.endsWith('*')) return argType.replace(/\*\s*$/, '').trim();
            if (argType.endsWith('[]')) return argType.slice(0, -2).trim();
            throw new Error(`helpers.getType: cannot dereference non-pointer type '${argType}' in expression '${target.text}'`);
          }
          return argType;
        }
        if (operator === '!') {
          return "int";
        }
        if (operator === '~' || operator === '+' || operator === '-') {
          const argType = this.getType(arg, options, _visited);
          if (typeof argType === 'string') {
            if (argType.includes('*') || argType.endsWith('[]')) throw new Error(`helpers.getType: invalid operand to unary '${operator}' in expression '${target.text}'`);
            // Integer promotion
            if (['char', 'short', 'bool', '_Bool'].includes(argType)) return 'int';
            return argType;
          }
          return argType;
        }
      }
    }

    if (target.type === 'binary_expression') {
      const left = target.named.left || target.child(0);
      const right = target.named.right || target.child(2);
      const operator = target.named.operator?.text || target.child(1)?.text;

      if (left && right && operator) {
        const lType = this.getType(left, options, _visited) as string;
        const rType = this.getType(right, options, _visited) as string;

        if (typeof lType === 'string' && typeof rType === 'string') {
          // Relational/Logical operators always return int in C
          if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator)) {
            return "int";
          }

          const lIsPtr = lType.includes('*') || lType.endsWith('[]');
          const rIsPtr = rType.includes('*') || rType.endsWith('[]');
          const lIsFloat = lType === 'float' || lType === 'double';
          const rIsFloat = rType === 'float' || rType === 'double';

          // Bitwise & Modulo restrictions
          if (['%', '|', '&', '^', '<<', '>>'].includes(operator)) {
            if (lIsFloat || rIsFloat) throw new Error(`helpers.getType: invalid operands to binary '${operator}' (have '${lType}' and '${rType}') in expression '${target.text}'`);
            if (lIsPtr || rIsPtr) throw new Error(`helpers.getType: invalid pointer operands to binary '${operator}' in expression '${target.text}'`);
          }

          if (lIsPtr || rIsPtr) {
            if (operator === '+') {
              if (lIsPtr && rIsPtr) throw new Error(`helpers.getType: cannot add two pointers in expression '${target.text}'`);
              return lIsPtr ? lType : rType;
            }
            if (operator === '-') {
              if (lIsPtr && rIsPtr) {
                // Technically ptrdiff_t, but long is conventionally used if ptrdiff_t is not strictly modeled
                return "long";
              }
              if (rIsPtr && !lIsPtr) throw new Error(`helpers.getType: invalid operands to binary '-' (have '${lType}' and '${rType}') in expression '${target.text}'`);
              return lType;
            }
            throw new Error(`helpers.getType: invalid operands to binary '${operator}' (have '${lType}' and '${rType}') in expression '${target.text}'`);
          }

          // Scalar promotion hierarchy
          const ranks = ['int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long', 'float', 'double'];
          let lNorm = lType;
          let rNorm = rType;
          if (['char', 'short', 'bool', '_Bool'].includes(lNorm)) lNorm = 'int';
          if (['char', 'short', 'bool', '_Bool'].includes(rNorm)) rNorm = 'int';

          const lRank = ranks.indexOf(lNorm);
          const rRank = ranks.indexOf(rNorm);

          if (lRank !== -1 && rRank !== -1) {
            return ranks[Math.max(lRank, rRank)];
          }

          // If structs or something else is somehow involved in arithmetic without overloading (C doesn't have it, but just in case), return the first one
          return lType;
        }
      }
    }

    let declNode: SourceNode<CNodeTypes> | undefined = target;
    let idNode: SourceNode<CNodeTypes> | undefined = (target.type === 'identifier' || target.type === 'type_identifier' || target.type === 'field_identifier') ? target : undefined;

    if (!idNode) {
      if ((target.type as string).endsWith('declarator') || target.type === 'init_declarator' || target.type === 'parameter_declaration') {
        const ids = target.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier');
        idNode = ids[0];
      }
      while (declNode &&
        !['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
        declNode = declNode.parent || (declNode as any)._detachedParent || undefined;
      }
      if (!declNode) return null;

      if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
        idNode = declNode.child(1) || undefined; // The tag
        if (idNode && idNode.type !== 'type_identifier' && idNode.type !== 'identifier') idNode = undefined;
      } else {
        // For other declarations, find the identifier in the declarator, avoiding the body
        const declarator = declNode.named.declarator;
        if (declarator) {
          idNode = declarator.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier')[0];
        } else {
          const ids = declNode.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier');
          idNode = declNode.type === 'type_definition' ? ids[ids.length - 1] : ids[0];
        }
      }
    } else {
      while (declNode &&
        !['declaration', 'parameter_declaration', 'field_declaration', 'type_definition', 'function_definition', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type)) {
        declNode = declNode.parent || (declNode as any)._detachedParent || undefined;
      }
    }

    if (!declNode) {
      if (target.type === 'type_identifier' && options.resolve) {
        let def = this.findDefinitionOrNull(target.text, { variable: true, tag: true });
        if (def && !_visited.has(def)) {
          _visited.add(target);
          return this.getType(def, options, _visited);
        }
      }
      return null;
    }

    let prefix = "";
    let suffix = "";

    if (idNode) {
      let p: SourceNode<CNodeTypes> | null = idNode;
      let isFunction = false;

      while (p && p !== declNode) {
        if (p.type === 'function_declarator') {
          isFunction = true;
        } else if (p.type === 'pointer_declarator') {
          prefix += "*";
        } else if (p.type === 'array_declarator') {
          suffix += "[]";
        }
        p = p.parent || (p as any)._detachedParent;
      }

      if (declNode.type === 'function_definition') {
        isFunction = true;
      }

      if (isFunction && !options.isCall) {
        if (options.resolve) {
          return declNode;
        }
        // Yield function signature type fallback string
        let retType = this.getType(declNode, { ...options, isCall: true }, _visited);
        let retTypeStr = typeof retType === 'string' ? retType : (retType ? retType.text : 'void');
        return `${retTypeStr} (*)()`;
      }
    }

    let typeNode = declNode.named.type;
    if (!typeNode) {
      typeNode = declNode.children.find(c =>
        ['primitive_type', 'type_identifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(c.type as string)
      );
      if (!typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(declNode.type as string)) {
        typeNode = declNode;
      }
    }

    if (options.resolve && typeNode && typeNode.type === 'type_identifier') {
      let def = this.findDefinitionOrNull(typeNode.text, { variable: true, tag: true });

      // Cross-tree fallback: search loaded dependency trees for type definitions
      if (!def) {
        for (const depHelpers of this.registry.dependencyHelpers) {
          def = (depHelpers as UppHelpersC).findDefinitionOrNull(typeNode.text, { variable: true, tag: true });
          if (def) break;
        }
      }

      if (def && (def.type === 'type_definition' || def.type === 'struct_specifier' || def.type === 'union_specifier' || def.type === 'enum_specifier')) {
        // Ensure we don't resolve to the same node or a node we already visited
        if (def !== target && !_visited.has(def)) {
          _visited.add(target);
          let underlyingType = this.getType(def, options, _visited);
          if (underlyingType === null) return null;
          if (typeof underlyingType !== 'string') {
            if (prefix || suffix) {
              return `${underlyingType.text} ${prefix}`.trim() + suffix;
            }
            return underlyingType;
          }

          // Strip structural bodies before collecting stars
          const cleanUnderlying = underlyingType.replace(/\{[^}]*\}/g, '');
          const uStars = cleanUnderlying.match(/\*/g)?.join('') || "";
          const uBase = underlyingType.replace(/\*/g, '').trim();
          // Merge prefixes: current pointers + underlying pointers
          const allStars = (prefix + uStars).trim();
          const result = `${uBase}${allStars ? ' ' + allStars : ''}`.trim() + suffix;
          return result.replace(/\s+/g, ' ');
        }
      }
    }

    if (options.resolve && typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(typeNode.type as string)) {
      if (!prefix && !suffix) {
        if (!typeNode.named.body) {
          const tag = typeNode.child(1);
          if (tag) {
            let def = this.findDefinitionOrNull(tag.text, { tag: true });

            if (def) {
              if (def.type === typeNode.type) {
                return def as SourceNode<CNodeTypes>;
              }
              if (def.parent && def.parent.type === typeNode.type) {
                return def.parent as SourceNode<CNodeTypes>;
              }
            }
          }
        }
        return typeNode as SourceNode<CNodeTypes>;
      }
    }

    let baseType = typeNode ? typeNode.text : "void";
    if (typeNode && ((typeNode.type as string) === 'struct_specifier' || (typeNode.type as string) === 'union_specifier' || (typeNode.type as string) === 'enum_specifier')) {
      const tag = typeNode.child(1);
      const kind = (typeNode.type as string).split('_')[0];
      baseType = tag ? `${kind} ${tag.text}` : typeNode.text;
    }

    let result = baseType || "void";
    if (prefix) result += " " + prefix;
    if (suffix) result += suffix;

    return result.trim().replace(/\s+/g, ' ');
  }

  /**
   * Returns the number of array dimensions wrapping an identifier.
   * @param {SourceNode<CNodeTypes>} defNode - The definition node.
   * @returns {number} Array depth.
   */
  getArrayDepth(defNode: SourceNode<CNodeTypes>): number {
    const type = this.getType(defNode);
    if (typeof type !== 'string') return 0;
    const matches = type.match(/\[\]/g);
    return matches ? matches.length : 0;
  }

  /**
   * Determines the lexical scope node for a given identifier.
   * @param {SourceNode<any>} node - The identifier node.
   * @returns {SourceNode<CNodeTypes>|null} The scope node.
   */
  getEnclosingScope(node: SourceNode<any>): SourceNode<CNodeTypes> | null {
    let p = node.parent || (node as any)._detachedParent;
    let counter = 0;
    let result: SourceNode<CNodeTypes> | null = null;

    while (p) {
      counter++;
      if (counter > 500) {
        console.error(`Extremely deep tree in getEnclosingScope! Depth > 500. Node: ${node.type} at ${node.startIndex}`);
        break;
      }
      if (p.type === 'compound_statement' || (p.type === 'translation_unit' && !p.parent)) {
        result = p as SourceNode<CNodeTypes>;
        break;
      }
      if (p.type === 'function_definition') {
        const declarator = p.named['declarator'];
        const parameters = declarator?.find('parameter_list')[0];
        const isInsideParams = parameters && (this.isDescendant(parameters, node) || parameters === node);

        if (declarator && (this.isDescendant(declarator, node) || declarator === node) && !isInsideParams) {
          p = p.parent || (p as any)._detachedParent;
          continue;
        }
        result = p as SourceNode<CNodeTypes>;
        break;
      }
      p = p.parent || (p as any)._detachedParent;
    }

    return result;
  }

  /**
   * Extracts function signature details including return type, name, parameters, and body.
   * @param {SourceNode<CNodeTypes>} fnNode - The function_definition node.
   * @returns {FunctionSignature} Signature details.
   */
  getFunctionSignature(fnNode: SourceNode<CNodeTypes>): FunctionSignature {
    const declarator = fnNode.named.declarator;
    let funcDeclarator = declarator;
    while (funcDeclarator && funcDeclarator.type !== 'function_declarator') {
      funcDeclarator = (funcDeclarator as any).named.declarator;
    }

    if (!funcDeclarator) {
      throw new Error("helpers.getFunctionSignature: function_declarator not found");
    }

    const nameNode = funcDeclarator.named.declarator;
    const name = nameNode ? nameNode.text : "";
    const params = funcDeclarator.named.parameters ? funcDeclarator.named.parameters.text : "()";
    const returnTypeRaw = this.getType(fnNode, { isCall: true });
    const returnType = typeof returnTypeRaw === 'string' ? returnTypeRaw : returnTypeRaw ? returnTypeRaw.text : "void";

    return new FunctionSignature(
      returnType,
      name,
      params,
      fnNode,
      nameNode,
      fnNode.named.body
    );
  }

  /**
   * Finds the definition for a node or name, returning null if not found.
   * @param {SourceNode<any>|string} target - The identifier node, a container node, or a scoping node (if name is provided).
   * @param {string | { variable?: boolean, tag?: boolean } | null} [nameOrOptions] - The name to find or options object.
   * @param {{ variable?: boolean, tag?: boolean }} [options] - Resolution options.
   * @returns {SourceNode<CNodeTypes>} The declaration/definition node.
   */
  findDefinition(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> {
    const def = this.findDefinitionOrNull(target, nameOrOptions, options);
    if (!def)
      throw new Error(`No definition for '${target.toString()}' found`);
    return def;
  }

  /**
   * Finds the definition for a node or name, throwing an error if not found.
   * @param {SourceNode<any>|string} target - The identifier node, a container node, or a scoping node (if name is provided).
   * @param {string | { variable?: boolean, tag?: boolean } | null} [nameOrOptions] - The name to find or options object.
   * @param {{ variable?: boolean, tag?: boolean }} [options] - Resolution options.
   * @returns {SourceNode<CNodeTypes>|null} The declaration/definition node or null.
   */
  findDefinitionOrNull(target: SourceNode<any> | string, nameOrOptions: string | { variable?: boolean, tag?: boolean } | null = null, options: { variable?: boolean, tag?: boolean } = { variable: true, tag: true }): SourceNode<CNodeTypes> | null {
    let name: string | null = null;
    let startScope: SourceNode<any> | null = null;
    let finalOptions = (typeof nameOrOptions === 'object' && nameOrOptions !== null) ? { ...options, ...nameOrOptions } : options;

    let cacheKey: string | number | null = null;
    let targetIsField = false;
    let structScopeForField: SourceNode<CNodeTypes> | null = null;

    if (typeof target === 'string') {
      name = target;
      startScope = this.contextNode || this.root;
    } else if (target instanceof SourceNode) {
      if (typeof nameOrOptions === 'string') {
        name = nameOrOptions;
        startScope = target;
      } else {
        let idNode = (target.type === 'identifier' || target.type === 'type_identifier' || target.type === 'field_identifier') ? target : null;
        if (!idNode) {
          const ids = target.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'field_identifier' || n.type === 'statement_identifier');
          if (ids.length === 1) idNode = ids[0];
        }

        if (!idNode) return null;
        name = ((idNode as any).searchableText as string) || idNode.text;
        startScope = idNode.parent || (idNode as any)._detachedParent || this.contextNode || this.root;
        cacheKey = idNode.startIndex; // Position-based caching

        let p = idNode.parent || (idNode as any)._detachedParent;
        if (idNode.type === 'field_identifier' && p?.type === 'field_expression' && p.named.field === idNode) {
          const argType = this.getType(p.named.argument, { resolve: true });
          if (argType instanceof SourceNode && ['struct_specifier', 'union_specifier'].includes(argType.type as string)) {
            structScopeForField = argType as SourceNode<CNodeTypes>;
            startScope = structScopeForField;
            targetIsField = true;
          }
        }
      }
    }

    if (!name || !startScope) {
      return null;
    }

    const findInScope = (scope: SourceNode<CNodeTypes>, isStructScope = false) => {
      const allIds = scope.find<CNodeTypes>((n: SourceNode<CNodeTypes>) => n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'field_identifier');
      const filtered = allIds.filter((idNode: SourceNode<CNodeTypes>) => {
        if (isStructScope) {
          let p = idNode.parent || (idNode as any)._detachedParent;
          while (p && p !== scope) {
            if (p.type === 'struct_specifier' || p.type === 'union_specifier') return false;
            if (p.type === 'field_declaration' && idNode.type === 'field_identifier') return true;
            p = p.parent || (p as any)._detachedParent;
          }
          return false;
        }
        return this.getEnclosingScope(idNode) === scope;
      });
      return filtered;
    };

    let current: SourceNode<CNodeTypes> | null = startScope;
    let loopCounter = 0;
    while (current) {
      loopCounter++;
      if (loopCounter > 1000) {
        throw new Error(`Infinite loop detected in findDefinition up-tree traversal for '${name}'! current.type=${current.type}`);
      }
      const identifiers = findInScope(current, targetIsField && current === structScopeForField);

      for (const idNode of identifiers) {
        if ((idNode as any).searchableText === name) {
          let p: SourceNode<CNodeTypes> | null = idNode;
          let isDeclarator = false;

          while (p && p !== current) {
            if ((p.type as string).endsWith('declarator') || p.type === 'init_declarator') {
              if (p.type === 'init_declarator') {
                let isInsideValue = false;
                let walk: SourceNode<any> | null = idNode;
                while (walk && walk !== p) {
                  if (walk.parent === p && walk.fieldName === 'value') {
                    isInsideValue = true;
                    break;
                  }
                  walk = walk.parent || (walk as any)._detachedParent;
                }
                if (isInsideValue) break;
                isDeclarator = true;
              } else {
                isDeclarator = true;
              }
            }
            if (p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') {
              // For structs/unions/enums, the tag is the second child of the specifier
              if (finalOptions.tag && p.child(1) === idNode) {
                const hasBody = !!p.named.body;
                const parentNode = p.parent || (p as any)._detachedParent;
                const hasDeclarator = parentNode && (
                  parentNode.named.declarator ||
                  parentNode.children.some((c: any) => c.type.includes('declarator'))
                );

                // A tag is a valid definition if it has a body OR it lacks a declarator (forward declaration)
                if (hasBody || !hasDeclarator) {
                  return p as SourceNode<CNodeTypes>;
                }
                // Otherwise, it's just a reference (like `struct S s;`), skip it
                break; // Break out of the while(p) loop, continue to next idNode
              }
              break; // Break out of the while(p) loop, continue to next idNode
            }
            if (p.type === 'parameter_declaration' || p.type === 'declaration' || p.type === 'type_definition' || p.type === 'field_declaration' || p.type === 'function_definition') {
              if (isDeclarator || (idNode.parent === p && idNode.fieldName !== 'type')) {
                if (finalOptions.variable || (p.type === 'field_declaration')) {
                  return p as SourceNode<CNodeTypes>;
                }
              }
              break;
            }
            p = p.parent || (p as any)._detachedParent;
          }
        }
      }

      if (targetIsField && current === structScopeForField) break;
      if (current.type === 'translation_unit') break;
      current = current.parent || (current as any)._detachedParent;
    }

    return null;
  }

  /**
   * Finds references to a definition.
   * @param {SourceNode<CNodeTypes>} node - The definition node.
   * @returns {SourceNode<CNodeTypes>[]} The references.
   */
  findReferences(node: SourceNode<CNodeTypes>): SourceNode<CNodeTypes>[] {
    const root = this.root;
    if (!root) return [];

    let targetDef: SourceNode<CNodeTypes> | null = null;
    try {
      targetDef = this.findDefinition(node);
    } catch {
      return [];
    }

    let idInDef = targetDef.type === 'identifier' || targetDef.type === 'field_identifier' || targetDef.type === 'type_identifier' ? targetDef : null;
    if (!idInDef) {
      const idsInDef = targetDef.find<CNodeTypes>((n: SourceNode<CNodeTypes>) =>
        n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier'
      );
      idInDef = idsInDef.find(n => {
        let p = n.parent || (n as any)._detachedParent;
        while (p && p !== targetDef) {
          if (p.type.endsWith('declarator') || p.type === 'init_declarator' || p.type === 'struct_specifier' || p.type === 'union_specifier' || p.type === 'enum_specifier') return true;
          p = p.parent || (p as any)._detachedParent;
        }
        return false;
      }) as SourceNode<CNodeTypes> | null;
      // fallback if no declarator matching
      if (!idInDef && idsInDef.length > 0) idInDef = idsInDef[0];
    }

    const name = idInDef ? idInDef.text : targetDef.text;
    if (!name || (idInDef && idInDef.type !== 'identifier' && idInDef.type !== 'field_identifier' && idInDef.type !== 'type_identifier')) {
      return [];
    }

    const refs: SourceNode<CNodeTypes>[] = [];
    const ids = root.find<CNodeTypes>((n: SourceNode<CNodeTypes>) =>
      n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier'
    );

    for (const idNode of ids) {
      if (idNode.text === name) {
        const def = this.findDefinitionOrNull(idNode);
        if (def && def === targetDef) {
          refs.push(idNode);
        } else if (!targetDef.parent && (targetDef as any)._detachedParent) {
          // Fallback for detached nodes: check name and scope equality
          const refScope = this.getEnclosingScope(idNode);
          const defScope = this.getEnclosingScope(targetDef);
          if (refScope && defScope && refScope === defScope) {
            refs.push(idNode);
          }
        }
      }
    }
    return refs;
  }

  /**
   * Checks if the currently being transformed node is the declaration node
   * for the symbol we are tracking with withReferences.
   * @returns {boolean} True if the current node is the declaration.
   */
  isDeclaration(): boolean {
    return false;
  }

  /**
   * Registers a rule to transform any identifier that resolves to a specific definition.
   * This is robust against code rewrites as it doesn't depend on specific node instances.
   * @param {SourceNode<CNodeTypes>} definitionNode - The definition node to track.
   * @param {function(SourceNode<CNodeTypes>, UppHelpersC): string|null|undefined} callback - Transformation callback.
   */
  withReferences(definitionNode: SourceNode<CNodeTypes>, callback: (n: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
    // Find the actual identifier name node within the definition
    let idNode = (definitionNode.type === 'identifier' || definitionNode.type === 'type_identifier') ? definitionNode : null;
    if (!idNode) {
      const ids = definitionNode.find<CNodeTypes>(n => n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'field_identifier');
      // We want the node that is acting as the "declarator"
      // Prioritize the identifier that findDefinition resolves back to this definitionNode.
      idNode = ids.find(id => this.findDefinitionOrNull(id) === definitionNode) ||
        ids.find(n => {
          let p = n.parent;
          while (p && p !== definitionNode) {
            const t = p.type;
            if (t.endsWith('declarator') || t === 'init_declarator') return true;
            p = p.parent;
          }
          return false;
        }) || ids.find(n => n.fieldName === 'declarator' || n.parent?.fieldName === 'declarator') || ids.find(n => {
          let p = n.parent;
          while (p && p !== definitionNode) {
            const t = p.type;
            if (t === 'struct_specifier' || t === 'union_specifier' || t === 'enum_specifier') return true;
            p = p.parent;
          }
          return false;
        }) || ids[ids.length - 1] || null;
    }

    if (!idNode) return;

    const declarationIdNode = idNode;
    const definitionName = idNode.text;
    const definitionScope = this.getEnclosingScope(definitionNode);

    const firedAt = new Set<number>();

    this.registry.registerPendingRule({
      matcher: (node, helpers) => {
        if (node.type !== 'identifier' && node.type !== 'type_identifier' && node.type !== 'field_identifier') return false;
        if (node.text !== definitionName) return false;
        if (firedAt.has(node.startIndex)) return false;

        const def = (helpers as UppHelpersC).findDefinitionOrNull(node);
        if (def) {
          // Compare by object reference — survives identity morphing
          if (def === definitionNode) {
            return true;
          }

          // Fallback for morphed definitions: match by scope reference
          const defScope = (helpers as UppHelpersC).getEnclosingScope(def);
          if (defScope && defScope === definitionScope) {
            return true;
          }
        } else {
          // Definition not found (tree was mutated). Check by scope.
          let walkScope: SourceNode<any> | null = (helpers as UppHelpersC).getEnclosingScope(node);
          while (walkScope) {
            if (walkScope === definitionScope) {
              return true;
            }
            const p: SourceNode<any> | null = walkScope.parent || (walkScope as any)._detachedParent;
            walkScope = p ? (helpers as UppHelpersC).getEnclosingScope(p) : null;
          }
        }
        return false;
      },
      callback: (node, helpers) => {
        firedAt.add(node.startIndex);
        const shadowHelpers = Object.create(helpers);
        shadowHelpers.isDeclaration = () => node === declarationIdNode;
        return callback(node as SourceNode<CNodeTypes>, shadowHelpers as UppHelpersC);
      }
    });
  }

  /**
   * Registers a rule to transform any expression within a scope that resolves to a specific target type.
   * @param {SourceNode<any>} scope - The scope within which to search for expressions.
   * @param {SourceNode<CNodeTypes> | string} target - The node or primitive string defining the type to match against.
   * @param {function(SourceNode<CNodeTypes>, UppHelpersC): string|null|undefined} callback - Transformation callback.
   */
  withExpressionType(scope: SourceNode<any>, target: SourceNode<CNodeTypes> | string, callback: (n: SourceNode<CNodeTypes>, helpers: UppHelpersC) => string | null | undefined): void {
    // Resolve the target type signature precisely once when registering.
    let targetType: string | SourceNode<CNodeTypes> | null = this.getType(target, { resolve: true });

    // If it did not resolve to a declaration, and the input was a string, assume it's a primitive type literal (e.g. "int")
    if (!targetType) {
      if (typeof target === 'string') targetType = target;
      else throw new Error(`helpers.withExpressionType: could not resolve target type for '${target.text}'`);
    }

    this.registry.registerPendingRule({
      matcher: (node, helpers) => {
        // Only evaluate expressions and literals
        const t = node.type;
        if (!t.endsWith('expression') && !t.endsWith('identifier') && !t.endsWith('literal')) return false;

        // Ensure the node is a descendant of the registration scope
        let isDescendant = false;
        let walkp: SourceNode<any> | null = node;
        while (walkp) {
          if (walkp === scope) {
            isDescendant = true;
            break;
          }
          walkp = walkp.parent || (walkp as any)._detachedParent;
        }
        if (!isDescendant) return false;

        // Compare types
        const exprType = (helpers as UppHelpersC).getType(node as SourceNode<CNodeTypes>, { resolve: true });
        if (!exprType) return false;

        const isMatch = (typeof targetType === 'string')
          ? (typeof exprType === 'string' && exprType === targetType)
          : (exprType === targetType);

        return isMatch;
      },
      callback: (node, helpers) => {
        return callback(node as SourceNode<CNodeTypes>, helpers as UppHelpersC);
      }
    });
  }

  /**
   * Replaces placeholders in an array of nodes/strings.
   * @param {InterpolationValue[]} values The values to expand.
   * @param {CNodeTypes} parentType The tree-sitter node type of the parent.
   * @returns {InterpolationValue[]} The expanded list of nodes/text.
   */
  getArrayExpansion(values: InterpolationValue[], _parentType: CNodeTypes): InterpolationValue[] {
    return values;
  }
}
