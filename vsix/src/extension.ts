import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    const virtualDocumentProvider = new class implements vscode.TextDocumentContentProvider {
        onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
        onDidChange = this.onDidChangeEmitter.event;

        async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
            const originalUriString = uri.query;
            if (!originalUriString) return '';

            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(originalUriString));
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
            } catch (e) {
                console.error(`[UPP] Failed to provide content for ${uri.toString()}:`, e);
                return `// Error loading document: ${e instanceof Error ? e.message : String(e)}`;
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

        private async generateTranspiled(doc: vscode.TextDocument): Promise<string> {
            const config = vscode.workspace.getConfiguration('upp');
            const customPath = config.get<string>('path');
            const originalPath = doc.uri.fsPath;
            const tempPath = path.join(os.tmpdir(), `.upp_preview_${path.basename(originalPath)}`);

            try {
                fs.writeFileSync(tempPath, doc.getText());

                return new Promise((resolve) => {
                    // Strategy 1: Use 'upp' from PATH if available and no custom path is set
                    const cmd = customPath ? `node "${path.join(customPath, 'index.js')}" --transpile "${tempPath}" -I "${path.dirname(originalPath)}"` : `upp --transpile "${tempPath}" -I "${path.dirname(originalPath)}"`;

                    exec(cmd, { cwd: path.dirname(originalPath) }, (err, stdout, stderr) => {
                        // If Strategy 1 fails (upp not in path) and we didn't have a custom path, try auto-detection
                        if (err && !customPath) {
                            this.fallbackTranspile(tempPath, resolve, originalPath);
                        } else {
                            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

                            let result = stdout.trim();
                            if (stderr) {
                                const cleanStderr = stderr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-m]/g, '');
                                result = `/*\n${cleanStderr}*/\n\n${result}`;
                            }

                            if (err && !stdout) {
                                resolve(`// Transpilation Error:\n${stderr || err.message}`);
                            } else {
                                resolve(result);
                            }
                        }
                    });
                });
            } catch (e) {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                return `// Extension Error: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        private fallbackTranspile(tempPath: string, resolve: (value: string) => void, originalPath: string) {
            // Strategy 2: Search for index.js in workspace or dev path
            let rootPath: string | undefined;
            const devPath = path.join(context.extensionUri.fsPath, '..');

            console.log(`[UPP] context.extensionUri: ${context.extensionUri.fsPath}`);
            console.log(`[UPP] Checking devPath: ${devPath}`);

            if (fs.existsSync(path.join(devPath, 'index.js')) || fs.existsSync(path.join(devPath, 'index.ts'))) {
                rootPath = devPath;
            } else if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    console.log(`[UPP] Checking workspace folder: ${folder.uri.fsPath}`);
                    if (fs.existsSync(path.join(folder.uri.fsPath, 'index.js')) || fs.existsSync(path.join(folder.uri.fsPath, 'index.ts'))) {
                        rootPath = folder.uri.fsPath;
                        break;
                    }
                }
            }

            if (!rootPath) {
                console.error(`[UPP] Failed to detect UPP root. devPath was: ${devPath}`);
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                resolve(`// Error: 'upp' command not found in PATH and UPP project not detected.\n// Please install UPP globally (npm i -g .) or set "upp.path" in settings.\n// (Tried searching in: ${devPath})`);
                return;
            }
            console.log(`[UPP] Using rootPath: ${rootPath}`);

            const hasJs = fs.existsSync(path.join(rootPath, 'index.js'));
            const indexScript = path.join(rootPath, hasJs ? 'index.js' : 'index.ts');
            const nodeArgs = hasJs ? '' : '--experimental-strip-types';

            exec(`node ${nodeArgs} "${indexScript}" --transpile "${tempPath}" -I "${path.dirname(originalPath)}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

                let result = stdout.trim();
                if (stderr) {
                    const cleanStderr = stderr.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-m]/g, '');
                    result = `/*\n${cleanStderr}*/\n\n${result}`;
                }

                if (err && !stdout) {
                    resolve(`// Transpilation Error (Fallback):\n${stderr || err.message}`);
                } else {
                    resolve(result);
                }
            });
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
        const filename = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
        const virtualUri = vscode.Uri.from({
            scheme: 'upp-virtual',
            authority: 'authority',
            path: `/(UPP) ${filename}.virtual${ext}`,
            query: document.uri.toString()
        });

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
        provideCompletionItems(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeCompletionItemProvider') as any; }
    }, '.', '@')); // Trigger on '@' and '.'

    context.subscriptions.push(vscode.languages.registerHoverProvider(['cup', 'hup'], {
        provideHover(doc, pos) { return forwardRequest(doc, pos, 'vscode.executeHoverProvider') as any; }
    }));

    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('upp.showVirtualC', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const filename = path.basename(editor.document.uri.fsPath, path.extname(editor.document.uri.fsPath));
            const uri = vscode.Uri.from({
                scheme: 'upp-virtual',
                authority: 'authority',
                path: `/(UPP) ${filename}.virtual.c`,
                query: editor.document.uri.toString()
            });
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('upp.showVirtualJS', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const filename = path.basename(editor.document.uri.fsPath, path.extname(editor.document.uri.fsPath));
            const uri = vscode.Uri.from({
                scheme: 'upp-virtual',
                authority: 'authority',
                path: `/(UPP) ${filename}.virtual.js`,
                query: editor.document.uri.toString()
            });
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('upp.showLivePreview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const filename = path.basename(editor.document.uri.fsPath, path.extname(editor.document.uri.fsPath));
            const uri = vscode.Uri.from({
                scheme: 'upp-transpile',
                authority: 'authority',
                path: `/(UPP) ${filename}.c`,
                query: editor.document.uri.toString()
            });
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        }
    }));

    // Auto-refresh logic (Debounced)
    const triggerRefresh = (doc: vscode.TextDocument) => {
        if (doc.languageId === 'cup' || doc.languageId === 'hup') {
            const docUriStr = doc.uri.toString();
            if (debounceTimers.has(docUriStr)) {
                clearTimeout(debounceTimers.get(docUriStr)!);
            }

            debounceTimers.set(docUriStr, setTimeout(() => {
                const filename = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));

                const transUri = vscode.Uri.from({
                    scheme: 'upp-transpile',
                    authority: 'authority',
                    path: `/(UPP) ${filename}.c`,
                    query: docUriStr
                });
                virtualDocumentProvider.onDidChangeEmitter.fire(transUri);

                const vC = vscode.Uri.from({
                    scheme: 'upp-virtual',
                    authority: 'authority',
                    path: `/(UPP) ${filename}.virtual.c`,
                    query: docUriStr
                });
                virtualDocumentProvider.onDidChangeEmitter.fire(vC);

                const vJS = vscode.Uri.from({
                    scheme: 'upp-virtual',
                    authority: 'authority',
                    path: `/(UPP) ${filename}.virtual.js`,
                    query: docUriStr
                });
                virtualDocumentProvider.onDidChangeEmitter.fire(vJS);

                debounceTimers.delete(docUriStr);
            }, 800));
        }
    };

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => triggerRefresh(e.document)));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) triggerRefresh(editor.document);
    }));
}

export function deactivate() { }
