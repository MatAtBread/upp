export interface MaterializeOptions {
    isAuthoritative: boolean;
}

export interface PatternMatchableNode {
    type: string;
    text: string;
    childCount: number;
    child(index: number): PatternMatchableNode | null;
}
