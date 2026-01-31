#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Registry } from './registry.js';
import { resolveConfig } from './config_loader.js';

const args = process.argv.slice(2);

if (!args.length) {
    console.error("Usage: node index.js <file.c>");
    process.exit(1);
}

for (const filePath of args)
{
    const absolutePath = path.resolve(filePath);
    const dirName = path.dirname(absolutePath);
    const baseName = path.basename(absolutePath);
    const ext = path.extname(baseName).slice(1);
    const fileNameWithoutExt = path.parse(baseName).name;

    // 1. Resolve Configuration
    const config = resolveConfig(absolutePath);
    const langConfig = (config.lang && config.lang[ext]) || {};

    /**
     * Executes a shell command with variable interpolation.
     * @param {string} cmd - The command string with ${VAR} placeholders.
     * @param {Object<string, string>} vars - Map of variable names to values.
     * @returns {string} The standard output of the command.
     */
    function runCommand(cmd, vars) {
        let finalCmd = cmd;
        for (const [key, value] of Object.entries(vars)) {
            finalCmd = finalCmd.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
        }
        try {
            return execSync(finalCmd, { cwd: dirName, encoding: 'utf8' });
        } catch (err) {
            console.error(`Command failed: ${finalCmd}`);
            console.error(err.message);
            process.exit(1);
        }
    }

    const vars = {
        'INPUT': absolutePath,
        'BASENAME': fileNameWithoutExt,
        'FILENAME': baseName
    };

    // 2. Resolve Initial Source
    let initialSource;
    if (langConfig['pre-upp']) {
        initialSource = runCommand(langConfig['pre-upp'], vars);
    } else {
        initialSource = fs.readFileSync(absolutePath, 'utf8');
    }

    // 3. Initialize Registry & Macros
    const registry = new Registry(config);
    registry.registerSource(initialSource, absolutePath);

    // 4. Transformation Stage
    const processedSource = registry.process();

    // 5. Post-upp Stage
    if (langConfig['post-upp']) {
        const outputPath = path.join(dirName, `upp.${baseName}`);
        fs.writeFileSync(outputPath, processedSource);

        const postVars = {
            ...vars,
            'OUTPUT': outputPath,
            'OUTPUT_BASENAME': fileNameWithoutExt
        };

        runCommand(langConfig['post-upp'], postVars);
    } else {
        console.log(`\n/* ${path.relative(process.cwd(), absolutePath)} */\n`);
        console.log(processedSource);
    }
}