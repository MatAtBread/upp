/**
 * Marker class for tracking source offsets during transformation.
 * All source modifications should go through Marker.splice() to ensure
 * that offsets and tree-sitter trees are updated correctly.
 */
class Marker {
    // Static registry: WeakMap<Tree, Set<Marker>> to track markers for each tree
    static #treeMarkers = new WeakMap();

    constructor(tree, offset, data = {}) {
        this.tree = tree;
        this.offset = offset;
        this.data = data;
        this.valid = true;

        // Register with tree
        if (!Marker.#treeMarkers.has(tree)) {
            Marker.#treeMarkers.set(tree, new Set());
        }
        Marker.#treeMarkers.get(tree).add(this);
    }

    /**
     * Centralized splice routine.
     * Updates source text, informs tree-sitter via tree.edit(),
     * and adjusts all registered markers.
     *
     * @param {object} tree - The Tree-sitter tree to update
     * @param {string} source - The current source text
     * @param {number} offset - Byte offset where modification begins
     * @param {number} deleteCount - Number of bytes to remove
     * @param {string} insertString - String to insert
     * @returns {string} The updated source text
     */
    static splice(tree, source, offset, deleteCount, insertString) {
        // Bounds check
        if (offset < 0) offset = 0;
        if (offset > source.length) offset = source.length;
        if (deleteCount < 0) deleteCount = 0;
        if (offset + deleteCount > source.length) deleteCount = source.length - offset;

        const insertLength = insertString.length;
        const delta = insertLength - deleteCount;

        const markers = Marker.#treeMarkers.get(tree);
        if (markers) {
            for (const marker of markers) {
                if (marker.offset >= offset + deleteCount) {
                    marker.offset += delta;
                } else if (marker.offset > offset && marker.offset < offset + deleteCount) {
                    marker.valid = false;
                }
            }
        }

        const startPosition = Marker.offsetToPosition(source, offset);
        const oldEndPosition = Marker.offsetToPosition(source, offset + deleteCount);

        const newSource = source.slice(0, offset) + insertString + source.slice(offset + deleteCount);
        const newEndPosition = Marker.offsetToPosition(newSource, offset + insertLength);

         try {
             console.log(`[DEBUG] tree.edit: start=${offset} del=${deleteCount} ins=${insertLength}`);
             // console.log(`[DEBUG] Pos: start=${startPosition.row}:${startPosition.column} end=${oldEndPosition.row}:${oldEndPosition.column} -> ${newEndPosition.row}:${newEndPosition.column}`);
            tree.edit({
                startIndex: offset,
                oldEndIndex: offset + deleteCount,
                newEndIndex: offset + insertLength,
                startPosition,
                oldEndPosition,
                newEndPosition
            });
         } catch (e) {
             console.error(`[DEBUG] tree.edit failed:`, e);
         }

        return newSource;
    }

    /**
     * Helper to convert byte offset to {row, column} for tree-sitter.
     * Note: This is a simple implementation; complex multibyte chars
     * might need a more robust version if UPP supports them.
     */
    static offsetToPosition(source, offset) {
        let row = 0;
        let col = 0;
        for (let i = 0; i < offset && i < source.length; i++) {
            if (source[i] === '\n') {
                row++;
                col = 0;
            } else {
                col++;
            }
        }
        return { row, column: col };
    }

    /**
     * Get the Tree-sitter node at this marker's current offset.
     * @param {Object} [options] - Search options.
     * @param {number} [options.id] - Target node ID.
     * @param {string} [options.type] - Target node type.
     */
    getNode(options = {}) {
        if (!this.valid) {
            throw new Error(`Marker at offset ${this.offset} is invalid (position was deleted)`);
        }
        let node = this.tree.rootNode.descendantForIndex(this.offset, this.offset);
        if (!node) return null;

        if (options.id !== undefined || options.type !== undefined) {
             // Walk up to find the node with matching ID or Type
             let current = node;
             while (current) {
                 if (options.id !== undefined && current.id === options.id) return current;
                 if (options.type !== undefined && current.type === options.type) return current;
                 current = current.parent;
             }
             // Fallback: if we didn't find the exact ID, but the type matches the deepest node, return it
        }

        return node;
    }

    /**
     * Migrates all markers from an old tree to a new tree after incremental parsing.
     * @param {object} oldTree - The tree that was edited.
     * @param {object} newTree - The new tree produced by parser.parse(source, oldTree).
     */
    static migrate(oldTree, newTree) {
        if (!oldTree || !newTree || oldTree === newTree) return;
        const markers = Marker.#treeMarkers.get(oldTree);
        if (markers) {
            for (const marker of markers) {
                marker.tree = newTree;
            }
            // Move the set to the new tree's key
            if (Marker.#treeMarkers.has(newTree)) {
                const existing = Marker.#treeMarkers.get(newTree);
                for (const m of markers) existing.add(m);
            } else {
                Marker.#treeMarkers.set(newTree, markers);
            }
            Marker.#treeMarkers.delete(oldTree);
        }
    }

    /**
     * Invalidate and remove from registry.
     */
    destroy() {
        const markers = Marker.#treeMarkers.get(this.tree);
        if (markers) {
            markers.delete(this);
        }
        this.valid = false;
    }
}

export default Marker;
