const fs = require('fs');
const path = require('path');

/**
 * Deep merges two objects. B overrides A.
 * @param {Object} a - The base object.
 * @param {Object} b - The overriding object.
 * @returns {Object} The merged object.
 */
function deepMerge(a, b) {
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
        return b;
    }
    const result = { ...a };
    for (const key in b) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
            if (key in a) {
                result[key] = deepMerge(a[key], b[key]);
            } else {
                result[key] = b[key];
            }
        }
    }
    return result;
}

/**
 * Loads a config file and recursively handles "extends".
 * @param {string} configPath - Path to the JSON config file.
 * @returns {Object} The loaded and merged configuration object.
 */
function loadConfig(configPath) {
    if (!fs.existsSync(configPath)) return {};

    let config = {};
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(content);
    } catch (err) {
        console.error(`Error parsing config file ${configPath}: ${err.message}`);
        return {};
    }

    if (config.extends) {
        let parentPath = config.extends;
        if (!path.isAbsolute(parentPath)) {
            parentPath = path.resolve(path.dirname(configPath), parentPath);
        }
        // If parentPath is a directory, look for upp.json inside it
        if (fs.existsSync(parentPath) && fs.lstatSync(parentPath).isDirectory()) {
            parentPath = path.join(parentPath, 'upp.json');
        }

        const parentConfig = loadConfig(parentPath);
        config = deepMerge(parentConfig, config);
        delete config.extends;
    }

    return config;
}

/**
 * Resolves the configuration for a given source file path.
 * Searches up the directory tree for upp.json until .git or root is reached.
 * @param {string} sourcePath - Absolute path to the source file.
 * @returns {Object} The resolved configuration.
 */
function resolveConfig(sourcePath) {
    let currentDir = path.dirname(path.resolve(sourcePath));
    let configPath = null;

    while (true) {
        const potentialPath = path.join(currentDir, 'upp.json');
        if (fs.existsSync(potentialPath)) {
            configPath = potentialPath;
            break;
        }

        // Stop if .git is found
        if (fs.existsSync(path.join(currentDir, '.git'))) {
            break;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break; // Reached root

        try {
            fs.accessSync(parentDir, fs.constants.R_OK);
        } catch (err) {
            break; // No permission
        }

        currentDir = parentDir;
    }

    if (configPath) {
        return loadConfig(configPath);
    }

    return { lang: {} }; // Return empty default if none found
}

module.exports = { resolveConfig, loadConfig, deepMerge };
