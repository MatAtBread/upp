"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
function activate(context) {
    let debounceTimer;
    const virtualDocumentProvider = new class {
        constructor() {
            this.onDidChangeEmitter = new vscode.EventEmitter();
            this.onDidChange = this.onDidChangeEmitter.event;
        }
        provideTextDocumentContent(uri, token) {
            console.log(`[UPP] Providing content for: ${uri.toString()}`);
            const originalUriString = uri.query;
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === originalUriString);
            if (!doc)
                return '';
            const content = doc.getText();
            if (uri.scheme === 'upp-virtual') {
                if (uri.path.endsWith('.c')) {
                    return this.generateMaskedC(content);
                }
                else if (uri.path.endsWith('.js')) {
                    return this.generateMaskedJS(content);
                }
            }
            else if (uri.scheme === 'upp-transpile') {
                return this.generateTranspiled(doc);
            }
            return '';
        }
        generateMaskedC(content) {
            // Mask @define blocks with spaces to keep C parser happy
            const regex = /@define(?:@[a-zA-Z0-9]+)?\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*\{/g;
            let masked = content;
            let match;
            while ((match = regex.exec(content)) !== null) {
                const bodyEnd = this.findClosingBrace(content, match.index + match[0].length);
                if (bodyEnd !== -1) {
                    const start = match.index;
                    const end = bodyEnd + 1;
                    masked = masked.substring(0, start) + ' '.repeat(end - start) + masked.substring(end);
                }
            }
            return masked;
        }
        generateMaskedJS(content) {
            const regex = /(@define(?:@[a-zA-Z0-9]+)?\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*\{)/g;
            // Join with root upp.d.ts
            const dtsPath = vscode.Uri.joinPath(context.extensionUri, 'upp.d.ts').fsPath;
            const header = `/// <reference path="${dtsPath.replace(/\\/g, '/')}" />\n`;
            let masked = header + ' '.repeat(content.length);
            let match;
            while ((match = regex.exec(content)) !== null) {
                const bodyStart = match.index + match[0].length;
                const bodyEnd = this.findClosingBrace(content, bodyStart);
                if (bodyEnd !== -1) {
                    masked = masked.substring(0, bodyStart + header.length) + content.substring(bodyStart, bodyEnd) + masked.substring(bodyEnd + header.length);
                }
            }
            return masked;
        }
        async generateTranspiled(doc) {
            const config = vscode.workspace.getConfiguration('upp');
            const customPath = config.get('path');
            const originalPath = doc.uri.fsPath;
            const tempPath = path.join(path.dirname(originalPath), `.upp_preview_${path.basename(originalPath)}`);
            try {
                fs.writeFileSync(tempPath, doc.getText());
                return new Promise((resolve) => {
                    // Strategy 1: Use 'upp' from PATH if available and no custom path is set
                    const cmd = customPath ? `node "${path.join(customPath, 'index.js')}" --transpile "${tempPath}"` : `upp --transpile "${tempPath}"`;
                    (0, child_process_1.exec)(cmd, { cwd: path.dirname(originalPath) }, (err, stdout, stderr) => {
                        // If Strategy 1 fails (upp not in path) and we didn't have a custom path, try auto-detection
                        if (err && !customPath) {
                            this.fallbackTranspile(tempPath, resolve);
                        }
                        else {
                            if (fs.existsSync(tempPath))
                                fs.unlinkSync(tempPath);
                            if (err)
                                resolve(`// Transpilation Error:\n${stderr || err.message}`);
                            else
                                resolve(stdout.trim());
                        }
                    });
                });
            }
            catch (e) {
                if (fs.existsSync(tempPath))
                    fs.unlinkSync(tempPath);
                return `// Extension Error: ${e instanceof Error ? e.message : String(e)}`;
            }
        }
        fallbackTranspile(tempPath, resolve) {
            // Strategy 2: Search for index.js in workspace or dev path
            let rootPath;
            const devPath = path.join(context.extensionUri.fsPath, '..', '..');
            if (fs.existsSync(path.join(devPath, 'index.js'))) {
                rootPath = devPath;
            }
            else if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    if (fs.existsSync(path.join(folder.uri.fsPath, 'index.js'))) {
                        rootPath = folder.uri.fsPath;
                        break;
                    }
                }
            }
            if (!rootPath) {
                if (fs.existsSync(tempPath))
                    fs.unlinkSync(tempPath);
                resolve(`// Error: 'upp' command not found in PATH and UPP project not detected.\n// Please install UPP globally (npm i -g .) or set "upp.path" in settings.`);
                return;
            }
            const indexScript = path.join(rootPath, 'index.js');
            (0, child_process_1.exec)(`node "${indexScript}" --transpile "${tempPath}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                if (fs.existsSync(tempPath))
                    fs.unlinkSync(tempPath);
                if (err)
                    resolve(`// Transpilation Error (Fallback):\n${stderr || err.message}`);
                else
                    resolve(stdout.trim());
            });
        }
        findClosingBrace(content, start) {
            let depth = 1;
            for (let i = start; i < content.length; i++) {
                if (content[i] === '{')
                    depth++;
                else if (content[i] === '}') {
                    depth--;
                    if (depth === 0)
                        return i;
                }
            }
            return -1;
        }
    };
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('upp-virtual', virtualDocumentProvider));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('upp-transpile', virtualDocumentProvider));
    // Intelligence Forwarding
    const forwardRequest = async (document, position, command) => {
        const offset = document.offsetAt(position);
        const text = document.getText();
        // Determine if we are inside a @define block
        let isInsideDefine = false;
        const regex = /@define(?:@[a-zA-Z0-9]+)?\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const bodyEnd = virtualDocumentProvider.findClosingBrace(text, match.index + match[0].length);
            if (offset >= match.index && offset <= bodyEnd) {
                isInsideDefine = true;
                break;
            }
        }
        const ext = isInsideDefine ? '.js' : '.c';
        const virtualUri = vscode.Uri.parse(`upp-virtual://authority/virtual${ext}?${document.uri.toString()}`);
        // CRITICAL: Ensure the virtual document is pre-loaded
        await vscode.workspace.openTextDocument(virtualUri);
        let virtualPosition = position;
        if (isInsideDefine) {
            const headerLines = 1; // /// <reference ... />
            virtualPosition = new vscode.Position(position.line + headerLines, position.character);
        }
        console.log(`[UPP] Forwarding ${command} to ${virtualUri.toString()} at ${virtualPosition.line}:${virtualPosition.character}`);
        const result = await vscode.commands.executeCommand(command, virtualUri, virtualPosition);
        console.log(`[UPP] Result for ${command}:`, result ? 'Found completions' : 'No result');
        return result;
    };
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['cup', 'hup'], {
        provideCompletionItems(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeCompletionItemProvider'); }
    }, '.', '@')); // Trigger on '@' and '.'
    context.subscriptions.push(vscode.languages.registerHoverProvider(['cup', 'hup'], {
        provideHover(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeHoverProvider'); }
    }));
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('upp.showVirtualC', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const uri = vscode.Uri.parse(`upp-virtual://authority/virtual.c?${editor.document.uri.toString()}`);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('upp.showVirtualJS', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const uri = vscode.Uri.parse(`upp-virtual://authority/virtual.js?${editor.document.uri.toString()}`);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('upp.showLivePreview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const uri = vscode.Uri.parse(`upp-transpile://authority/transpiled.c?${editor.document.uri.toString()}`);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));
    // Auto-refresh logic (Debounced)
    const triggerRefresh = (doc) => {
        if (doc.languageId === 'cup' || doc.languageId === 'hup') {
            if (debounceTimer)
                clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const docUriStr = doc.uri.toString();
                const transUri = vscode.Uri.parse(`upp-transpile://authority/transpiled.c?${docUriStr}`);
                virtualDocumentProvider.onDidChangeEmitter.fire(transUri);
                const vC = vscode.Uri.parse(`upp-virtual://authority/virtual.c?${docUriStr}`);
                virtualDocumentProvider.onDidChangeEmitter.fire(vC);
                const vJS = vscode.Uri.parse(`upp-virtual://authority/virtual.js?${docUriStr}`);
                virtualDocumentProvider.onDidChangeEmitter.fire(vJS);
            }, 800); // Faster refresh
        }
    };
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => triggerRefresh(e.document)));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor)
            triggerRefresh(editor.document);
    }));
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map