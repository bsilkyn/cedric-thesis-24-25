import * as vscode from 'vscode';
import { DocumentManager } from '@/document_manager';
import { diagnostics, metadataByUri, validateDocument, MissingCaseFixProvider} from '@/server';

let dm: DocumentManager | null = null;

export function activate(ctx: vscode.ExtensionContext): void {
	dm = new DocumentManager(ctx);

	ctx.subscriptions.push(diagnostics);

	const validate = (document: vscode.TextDocument) => {
		if (document.languageId === "sasylf") {
		void validateDocument(ctx, document);
		}
	};

	ctx.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(validate),
		vscode.workspace.onDidSaveTextDocument(validate),
		vscode.workspace.onDidChangeTextDocument(event => validate(event.document)),
		vscode.workspace.onDidCloseTextDocument(document => {
		diagnostics.delete(document.uri);
		metadataByUri.delete(document.uri.toString());
		}),
		    vscode.languages.registerCodeActionsProvider(
				{ language: "sasylf" },
				new MissingCaseFixProvider(),
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
	);

	ctx.subscriptions.push(vscode.commands.registerCommand('live-sasylf.runToCursor', () => {
		dm!.runToCursor();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('live-sasylf.runNext', () => {
		dm!.runNext();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('live-sasylf.openContextView', () => {
		dm!.openContextView();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('live-sasylf.restartCurrentProcess', () => {
		dm!.restart(ctx);
	}));

	for (const document of vscode.workspace.textDocuments) {
		validate(document);
	}
}

export function deactivate(): void {
	dm?.close();
	dm = null;

	diagnostics.clear();
	metadataByUri.clear();
}
