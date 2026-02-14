/**
 * Caches macro definitions and include dependencies for files.
 * @class
 */
export class DependencyCache {
    constructor() {
        /**
         * @type {Map<string, {macros: Array<Object>, transformRules: Array<Object>, output: string}>}
         */
        this.cache = new Map();
    }

    /**
     * Checks if a file is in the cache.
     * @param {string} filePath - Absolute path.
     * @returns {boolean}
     */
    has(filePath) {
        return this.cache.has(filePath);
    }

    /**
     * Gets data for a file.
     * @param {string} filePath
     * @returns {{macros: Array<Object>, transformRules: Array<Object>, output: string}|undefined}
     */
    get(filePath) {
        return this.cache.get(filePath);
    }

    /**
     * Sets data for a file.
     * @param {string} filePath
     * @param {{macros: Array<Object>, transformRules: Array<Object>, output: string}} data
     */
    set(filePath, data) {
        this.cache.set(filePath, data);
    }
}
