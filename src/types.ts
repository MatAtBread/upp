import type { SourceNode, SourceTree } from './source_tree.ts';

export interface MaterializeOptions {
    isAuthoritative: boolean;
}

export interface PatternMatchableNode {
    type: string;
    text: string;
    childCount: number;
    child(index: number): PatternMatchableNode | null;
}

/**
 * Branded type for Tree-sitter Language objects.
 * Prevents accidental assignment of generic objects to language fields.
 */
export type Language = any & { readonly __brand: unique symbol };

/**
 * Common return type for macro evaluations and transformations.
 */
export type MacroResult<T extends string = string> =
    | SourceNode<T>
    | SourceNode<any>[]
    | SourceTree<any>
    | string
    | null
    | undefined;

/**
 * Type alias for any SourceNode.
 */
export type AnySourceNode = SourceNode<any>;

/**
 * Type alias for any SourceTree.
 */
export type AnySourceTree = SourceTree<any>;

/**
 * Types that can be interpolated into UPP code fragments.
 */
export type InterpolationValue = string | number | boolean | AnySourceNode | AnySourceTree | AnySourceNode[] | null | undefined;
