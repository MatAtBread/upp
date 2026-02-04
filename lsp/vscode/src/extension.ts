import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    let debounceTimer: NodeJS.Timeout | undefined;

    const virtualDocumentProvider = new class implements vscode.TextDocumentContentProvider {
        onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
        onDidChange = this.onDidChangeEmitter.event;

        provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): string | Thenable<string> {
            const originalUriString = uri.query;
            const doc = vscode.workspace.textDocuments.find((d: vscode.TextDocument) => d.uri.toString() === originalUriString);
            if (!doc) return '';

            const content = doc.getText();

            if (uri.scheme === 'upp-virtual') {
                if (uri.path.endsWith('.c')) {
                    return this.generateMaskedC(content);
                } else if (uri.path.endsWith('.js')) {
                    return this.generateMaskedJS(content);
                }
            } else if (uri.scheme === 'upp-transpile') {
                return this.generateTranspiled(doc);
            }
            return '';
        }

        private generateMaskedC(content: string): string {
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

        private generateMaskedJS(content: string): string {
            const regex = /(@define(?:@[a-zA-Z0-9]+)?\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*\{)/g;
            // Join with root upp.d.ts
            const dtsPath = vscode.Uri.joinPath(context.extensionUri, '..', 'upp.d.ts').fsPath;
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

        private async generateTranspiled(doc: vscode.TextDocument): Promise<string> {
            const rootPath = path.join(context.extensionUri.fsPath, '..', '..');
            const transpileScript = path.join(rootPath, 'transpile.js');
            const originalPath = doc.uri.fsPath;
            const tempPath = path.join(path.dirname(originalPath), `.upp_preview_${path.basename(originalPath)}`);

            try {
                fs.writeFileSync(tempPath, doc.getText());

                return new Promise((resolve) => {
                    exec(`node "${transpileScript}" "${tempPath}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

                        if (err) {
                            resolve(`// Transpilation Error (Exit Code ${err.code}):\n${stderr || err.message}`);
                        } else {
                            // SPLIT ROBUSTLY: The transpiler uses 40 '=' characters
                            const separator = "========================================\n";
                            const parts = stdout.split(separator);

                            if (parts.length >= 3) {
                                // Content is after the 2nd separator (FILE header)
                                resolve(parts[2].trim());
                            } else {
                                resolve("// Unexpected output format from transpiler:\n" + stdout);
                            }
                        }
                    });
                });
            } catch (e) {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                return `// Extension Error: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        public findClosingBrace(content: string, start: number): number {
            let depth = 1;
            for (let i = start; i < content.length; i++) {
                if (content[i] === '{') depth++;
                else if (content[i] === '}') {
                    depth--;
                    if (depth === 0) return i;
                }
            }
            return -1;
        }
    };

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('upp-virtual', virtualDocumentProvider));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('upp-transpile', virtualDocumentProvider));

    // Intelligence Forwarding
    const forwardRequest = async (document: vscode.TextDocument, position: vscode.Position, command: string) => {
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

        return vscode.commands.executeCommand(command, virtualUri, virtualPosition);
    };

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['cup', 'hup'], {
        provideCompletionItems(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeCompletionItemProvider') as any; }
    }, '.', '@')); // Trigger on '@' and '.'

    context.subscriptions.push(vscode.languages.registerHoverProvider(['cup', 'hup'], {
        provideHover(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeHoverProvider') as any; }
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
    const triggerRefresh = (doc: vscode.TextDocument) => {
        if (doc.languageId === 'cup' || doc.languageId === 'hup') {
            if (debounceTimer) clearTimeout(debounceTimer);
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
        if (editor) triggerRefresh(editor.document);
    }));
}

export function deactivate() {}
