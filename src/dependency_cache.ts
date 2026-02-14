import type { Macro, TransformRule } from './registry.ts';

export interface CacheData {
    macros: Macro[];
    transformRules: TransformRule[];
    output: string;
    shouldMaterialize: boolean;
    isAuthoritative: boolean;
}

/**
 * Caches macro definitions and include dependencies for files.
 * @class
 */
export class DependencyCache {
    private cache: Map<string, CacheData>;

    constructor() {
        /**
         * @type {Map<string, CacheData>}
         */
        this.cache = new Map();
    }

    /**
     * Checks if a file is in the cache.
     * @param {string} filePath - Absolute path.
     * @returns {boolean}
     */
    has(filePath: string): boolean {
        return this.cache.has(filePath);
    }

    /**
     * Gets data for a file.
     * @param {string} filePath
     * @returns {CacheData | undefined}
     */
    get(filePath: string): CacheData | undefined {
        return this.cache.get(filePath);
    }

    /**
     * Sets data for a file.
     * @param {string} filePath
     * @param {CacheData} data
     */
    set(filePath: string, data: CacheData): void {
        this.cache.set(filePath, data);
    }
}
