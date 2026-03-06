import { UppHelpersC } from './upp_helpers_c.ts';
import { UppHelpersBase } from './upp_helpers_base.ts';
import { SourceTree, SourceNode } from './source_tree.ts';
import type { Registry, RegistryContext } from './registry.ts';

/**
 * Encapsulates the transformation pipeline for a single source file.
 * Registry is a pure macro/rule store; Transformer runs the AST walk.
 */
export class Transformer {
  private registry: Registry;
  constructor(registry: Registry) {
    this.registry = registry;
  }

  /**
   * Transforms preprocessed source by expanding macros and applying rules.
   * Returns the final C source string.
   */
  run(source: string, originPath: string = 'unknown', parentHelpers: UppHelpersC | null = null): string {
    const registry = this.registry;
    registry.source = source;
    if (!source) return "";

    // Initialize tree and helpers early so dependencies loaded during
    // prepareSource() can see this registry's tree via parentRegistry.
    registry.tree = new SourceTree<any>(source, registry.language as any);
    if (!registry.tree) throw new Error("Could not create source tree for transformation.");

    registry.tree.onMutation = () => registry.markMutated();
    registry.helpers = new UppHelpersC(registry, parentHelpers) as any;

    // Initial invocation processing populates macro definitions without mutating the tree
    const { cleanSource, invocations: foundInvs } = registry.prepareSource(source, originPath);

    // Rebuild tree if preprocessing mutated the raw text
    if (cleanSource !== source) {
      registry.tree = new SourceTree<any>(cleanSource || "", registry.language as any);
    }

    const helpers = new UppHelpersC(registry, parentHelpers) as any;

    const context: RegistryContext = {
      source: registry.tree.source,
      tree: registry.tree,
      originPath,
      invocations: foundInvs,
      helpers,
      pendingRules: registry.pendingRules // Shared reference
    };

    helpers.context = context;

    if (!registry.mainContext) {
      registry.mainContext = context;
    }

    if (parentHelpers) {
      helpers.parentHelpers = parentHelpers;
      helpers.parentRegistry = {
        invocations: parentHelpers.context?.invocations || [],
        sourceCode: parentHelpers.context?.tree?.source || parentHelpers.context?.source || "",
        helpers: parentHelpers
      };
      helpers.topLevelInvocation = (parentHelpers as any).topLevelInvocation || (parentHelpers as any).invocation;
      helpers.currentInvocations = foundInvs.length > 0 ? foundInvs : ((parentHelpers as any).currentInvocations || []);
    } else {
      helpers.currentInvocations = foundInvs;
    }

    const walkerDone = new WeakSet<SourceNode<any>>();
    context.walkerDone = walkerDone;

    const it = this.walk(registry.tree.root, walkerDone);
    let newSubTree: SourceNode<any> | undefined = undefined;
    for (let { value, done } = it.next(); value && !done; { value, done } = it.next(newSubTree)) {
      newSubTree = this.transformNode(value, helpers, context);
    }

    return registry.tree.source;
  }

/**
 * A back-tracking depth-first tree walker.
 * This is aware that the tree structure may change during iteration, 
 * and attempts to walk all nodes in the tree.
 * 
 * This implementation works by finding the deepest unvisited child, yielding
 * and then repeating the same process until nothing is found. It does not
 * need to track changes to node structures (parents/siblings) as it always
 * seeks.
 * 
 * A node can be re-added to the search tree by calling revisit that removes
 * the node and all it's parents from the `done` set.
 * 
 * Question: how to ensure any new nodes added to the tree are *always* found.
 * They will be added and discoverable iff all their parents are not in `done`
 * 
 * @param node 
 */
  private *walk(start: SourceNode<any>, done: WeakSet<SourceNode<any>>): Generator<SourceNode<any>, SourceNode<any> | undefined, SourceNode<any> | undefined> {
    let node: SourceNode<any> = start;
    
    while (true) {
      const unvisitedChildren = node.children.filter(ch => !done.has(ch));
      if (unvisitedChildren.length) {
        node = unvisitedChildren[0];
        continue;
      }
      if (!done.has(node)) {
        done.add(node);
        const injectedTree = yield node;
        if (injectedTree) {
          yield* this.walk(injectedTree, done);
        }
        node = start;
        continue;
      }
      return;
    }
  }


  private transformNode(node: SourceNode<any>, helpers: UppHelpersBase<any>, context: RegistryContext): SourceNode<any> | undefined {
    let iterations = 0;
    const MAX_ITERATIONS = 50;
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      if (!node || node.startIndex === -1 || !node.isValid) {
        debugger;
        break;
      }

      for (const rule of context.pendingRules) {
        try {
          // Guard against infinite re-match loops: if this node was produced
          // as a replacement by this same rule, skip it.
          if (rule.substituted?.has(node)) continue;

          if (rule.matcher(node, helpers)) {
            const oldContext = helpers.contextNode;
            helpers.contextNode = node;
            const substitution = rule.callback(node, helpers);
            helpers.contextNode = oldContext;

            if (substitution === undefined || substitution === node) {
              // Consume one-shot rules after they fire
              if (rule.oneShot) {
                context.pendingRules.delete(rule);
              }
              continue; // No substitution — try remaining rules
            }

            if (substitution === null) {
              node.remove();
              break;
            } else {
              const result = helpers.replace(node, substitution);

              // After substitution, walk the replacement subtree and add any nodes
              // matching this rule's pattern into rule.substituted. This prevents the
              // rule from re-firing on fresh but structurally-identical copies produced
              // by the callback (e.g. returning node.text creates a new matching node).
              // This fires only for persistent (non-oneShot) rules, since oneShot rules
              // self-remove after their first successful substitution anyway.
              if (!rule.oneShot && result) {
                if (!rule.substituted) rule.substituted = new WeakSet<object>();
                const resultNodes = Array.isArray(result) ? result : [result];
                for (const r of resultNodes) {
                  helpers.walk(r as any, (n: any) => {
                    //try {
                      //if (rule.matcher(n, helpers)) {
                        rule.substituted!.add(n);
                      //}
                    //} catch { /* ignore matcher errors during pre-marking */ }
                  });
                }
              }

              // If result is a different node, the walker will detect the
              // replacement at the same index and visit the new subtree.
              // If result IS the same node (identity morph from replaceWith),
              // the walker won't detect it, so return it as an injectedTree
              // for the walker to re-descend and discover new children.
              if (result === node) {
                return node; // Morphed in place — walker re-walks new children
              }
              break; // Structurally replaced — walker detects at same index

            }
          }
        } catch (e: any) {
          console.warn(`[upp] rule failed on ${node.type}: ${e.message}`);
        }
      }
      return;
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(`[UPP] Maximum substitution iterations (${MAX_ITERATIONS}) reached for node of type ${node.type}. Possible infinite generation loop.`);
    }
  }

}
