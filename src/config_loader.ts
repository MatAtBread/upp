import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DependencyCache } from './dependency_cache.ts';
import type { DiagnosticsManager } from './diagnostics.ts';

const UPP_INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Deep merges two objects. B overrides A.
 * @param {any} a - The base object.
 * @param {any} b - The overriding object.
 * @returns {any} The merged object.
 */
function deepMerge(a: any, b: any): any {
    if (b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
        return [...new Set([...a, ...b])];
    }
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

export interface UppConfig {
    lang?: Record<string, any>;
    includePaths?: string[];
    cache?: DependencyCache | null;
    write?: boolean;
    diagnostics?: DiagnosticsManager;
    suppress?: string[];
    extends?: string;
}

/**
 * Loads a config file and recursively handles "extends".
 * @param {string} configPath - Path to the JSON config file.
 * @returns {UppConfig} The loaded and merged configuration object.
 */
function loadConfig(configPath: string): UppConfig {
    if (!fs.existsSync(configPath)) return {};

    const configDir = path.dirname(configPath);
    let config: any = {};
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(content);
    } catch (err: any) {
        console.error(`Error parsing config file ${configPath}: ${err.message}`);
        return {};
    }

    // Resolve includePaths relative to THIS config file
    const resolvePath = (p: string) => {
        const expanded = p.replace('${UPP}', UPP_INSTALL_DIR);
        return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
    };

    if (config.includePaths) {
        config.includePaths = config.includePaths.map(resolvePath);
    }

    if (config.extends) {
        let parentPath = config.extends;
        if (!path.isAbsolute(parentPath)) {
            parentPath = path.resolve(configDir, parentPath);
        }
        // If parentPath is a directory, look for upp.json inside it
        if (fs.existsSync(parentPath) && fs.lstatSync(parentPath).isDirectory()) {
            parentPath = path.join(parentPath, 'upp.json');
        }

        const parentConfig = loadConfig(parentPath);
        config = deepMerge(parentConfig, config);
        delete config.extends;
    }

    return config as UppConfig;
}

/**
 * Resolves the configuration for a given source file path.
 * Searches up the directory tree for upp.json until .git or root is reached.
 * @param {string} sourcePath - Absolute path to the source file.
 * @returns {UppConfig} The resolved configuration.
 */
function resolveConfig(sourcePath: string): UppConfig {
    let currentDir = path.dirname(path.resolve(sourcePath));
    let configPath: string | null = null;

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

    // Final fallback: check UPP installation directory
    const installConfigPath = path.join(UPP_INSTALL_DIR, 'upp.json');
    if (fs.existsSync(installConfigPath)) {
        return loadConfig(installConfigPath);
    }

    return { lang: {} }; // Return empty default if none found
}

export { resolveConfig, loadConfig, deepMerge };
