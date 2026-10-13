import * as vscode from 'vscode';
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/** Metadata returned by SASyLF's --lsp JSON output for one diagnostic. */
type BackendQuickfix = {
    severity?: string;
    error_type?: string;
    error_info?: string;
    error_message?: string;
    begin_line?: number;
    begin_column?: number;
    end_line?: number;
    end_column?: number;
}

type BackendResponse = {
    quickfixes?: BackendQuickfix[];
    ast?: unknown;
}

type QuickfixMetadata = {
    errorType: string;
    errorInfo: string;
    range: vscode.Range;
}

const DIAGNOSTIC_SOURCE = "live-sasylf";
export const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);

// The backend's diagnostic code is the index into `quickfixes`; retain its
// error_info so the code action can generate the same fix as the original server.
export const metadataByUri = new Map<string, Map<number, QuickfixMetadata>>();
let validationGeneration = 0;


// Parses diagnostic and ast information from sasylf
export async function validateDocument(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
): Promise<void> {
    const generation = ++validationGeneration;
    const jarPath = context.asAbsolutePath(path.join("", "packages", "extension", "SASyLF.jar"));

    // This mirrors the original extension's backend protocol: document text on stdin,
    // JSON containing `quickfixes` and `ast` on stdout.
    const result = spawnSync("java", ["-jar", jarPath, "--lsp", "--stdin"], {
        input: document.getText(),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error || result.status !== 0 && !result.stdout) {
        const detail = result.error?.message ?? result.stderr ?? `Java exited with status ${result.status}`;
        console.error(`[${DIAGNOSTIC_SOURCE}] SASyLF validation failed: ${detail}`);
        diagnostics.set(document.uri, []);
        metadataByUri.delete(document.uri.toString());
        return;
    }

    let response: BackendResponse;
    try {
        response = JSON.parse(result.stdout) as BackendResponse;
    } catch (error) {
        console.error(`[${DIAGNOSTIC_SOURCE}] Could not parse SASyLF JSON output`, error, result.stderr);
        return;
    }

    // A newer validation may have started while this one was running. Do not publish
    // an older result over it. Also ensure the document has not changed since we read it.
    if (generation !== validationGeneration) {return;}

    const metadata = new Map<number, QuickfixMetadata>();
    const published: vscode.Diagnostic[] = [];
    const items = response.quickfixes ?? [];
    const maxProblems = vscode.workspace.getConfiguration("sasylf").get<number>("maxNumberOfProblems", 1000);

    for (let index = 0; index < items.length && published.length < maxProblems; index++) {
        const item = items[index];
        if (!item || item.severity === "info") {continue;}
        if (typeof item.begin_line !== "number" || typeof item.begin_column !== "number" ||
            typeof item.end_line !== "number" || typeof item.end_column !== "number") {continue;}

        const range = new vscode.Range(
            Math.max(0, item.begin_line - 1), Math.max(0, item.begin_column - 1),
            Math.max(0, item.end_line - 1), Math.max(0, item.end_column - 1),
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            item.error_message ?? "SASyLF reported an issue.",
            item.severity === "warning"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = index;
        published.push(diagnostic);

        // eslint-disable-next-line eqeqeq
        if (item.severity === "error" && item.error_type && item.error_info != null) {
            metadata.set(index, { errorType: item.error_type, errorInfo: item.error_info, range });
        }
    }

    metadataByUri.set(document.uri.toString(), metadata);
    diagnostics.set(document.uri, published);
}

export class MissingCaseFixProvider implements vscode.CodeActionProvider {
    provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const metadata = metadataByUri.get(document.uri.toString());
        if (!metadata) {return [];}

        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== DIAGNOSTIC_SOURCE || typeof diagnostic.code !== "number") {continue;}
            const fix = metadata.get(diagnostic.code);
            if (!fix || fix.errorType !== "MISSING_CASE") {continue;}

            const action = this.makeMissingCaseAction(document, diagnostic, fix);
            if (action) {
                actions.push(action);
            }
        }
        return actions;
    }

    private makeMissingCaseAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    fix: QuickfixMetadata,
    ): vscode.CodeAction | undefined {
        const line = fix.range.start.line;
        if (line < 0 || line >= document.lineCount) {return undefined;}

        const lineText = document.lineAt(line).text;
        const lineIndent = lineText.match(/^[ \t]*/)?.[0] ?? "";
        const indentSize = vscode.workspace.getConfiguration("editor", document.uri).get<number>("tabSize", 4);
        const indent = indentSize >= 0 && indentSize <= 8 ? "        ".slice(0, indentSize) : "    ";
        const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const split = fix.errorInfo.split(/\r?\n/);

        let newText = "";
        if (!fix.errorInfo.includes("\n\n")) {
            // Syntax cases: each non-trailing line in error_info is a missing case label.
            const count = split.length - 1; // backend format has a trailing newline
            for (let i = 0; i < count; i++) {
                newText += `${lineIndent}${indent}case ${split[i]} is${eol}`;
                newText += `${lineIndent}${indent}${indent}proof by unproved${eol}`;
                newText += `${lineIndent}${indent}end case${eol}${eol}`;
            }
        } else {
            // Rule-case format: blank lines delimit generated case blocks. The backend's
            // error_info lines beginning with --- identify rule cases; other lines are premises.
            let startCase = true;
            const count = split.length - 1;
            for (let i = 0; i < count; i++) {
                if (startCase) {
                    newText += `${lineIndent}${indent}case rule${eol}`;
                    startCase = false;
                }
                if (split[i].length === 0) {
                    newText += `${lineIndent}${indent}is${eol}`;
                    newText += `${lineIndent}${indent}${indent}proof by unproved${eol}`;
                    newText += `${lineIndent}${indent}end case${eol}${eol}`;
                    startCase = true;
                    continue;
                }
                const content = split[i].startsWith("---") ? split[i] : `_: ${split[i]}`;
                newText += `${lineIndent}${indent}${indent}${content}${eol}`;
            }
        }

        const edit = new vscode.WorkspaceEdit();
        const trimmed = lineText.trim();

        // Match the original extension's special action for contradiction proofs.
        if (trimmed.includes("by contradiction on") && !trimmed.includes("by case analysis on")) {
            const match = trimmed.match(/by contradiction on\s+(\S+)\s*$/);
            if (match) {
                const contradictionOffset = lineText.indexOf("contradiction");
                const start = new vscode.Position(line, contradictionOffset);
                const end = new vscode.Position(line, lineText.length);
                newText = `case analysis on ${match[1]}:${eol}${newText}${lineIndent}end case analysis${eol}`;
                edit.replace(document.uri, new vscode.Range(start, end), newText);
                const action = new vscode.CodeAction(
                    "convert to case analysis with missing case(s)",
                    vscode.CodeActionKind.QuickFix,
                );
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.edit = edit;
                return action;
            }
        }

        // Insert generated cases after the line containing the incomplete analysis.
        const insertAt = new vscode.Position(line + 1, 0);
        edit.insert(document.uri, insertAt, newText);
        const action = new vscode.CodeAction("insert missing case(s)", vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = edit;
        return action;
    }
}