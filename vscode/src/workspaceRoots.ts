import { isAbsolute, normalize } from "node:path";
import * as vscode from "vscode";

export interface WorkspaceRootError {
  code: string;
  message: string;
  status?: number;
}

export type WorkspaceRootChoice = { path: string } | { error: WorkspaceRootError };

export interface WorkspaceRootAdapter {
  choose(): Promise<WorkspaceRootChoice | undefined>;
  validate(path: string): WorkspaceRootError | undefined;
  onDidChange(listener: () => void): vscode.Disposable;
}

function topologyError(): WorkspaceRootError | undefined {
  if (!vscode.workspace.isTrusted) {
    return { code: "workspace_untrusted", message: "Workspace inspection requires VS Code workspace trust. No files were inspected." };
  }
  if (vscode.env.remoteName) {
    return { code: "workspace_remote_unsupported", message: "Remote workspace inspection is not supported until an explicit topology adapter is available." };
  }
  return undefined;
}

function folderError(folder: vscode.WorkspaceFolder): WorkspaceRootError | undefined {
  if (folder.uri.scheme !== "file" || folder.uri.authority || !isAbsolute(folder.uri.fsPath)) {
    return { code: "workspace_uri_unsupported", message: "Choose a local file workspace folder. Non-file and remote roots are not supported." };
  }
  return undefined;
}

export function createWorkspaceRootAdapter(): WorkspaceRootAdapter {
  return {
    async choose() {
      const error = topologyError();
      if (error) return { error };
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length) {
        return { error: { code: "workspace_root_not_selected", message: "Open a local workspace folder, then choose its explicit inspection root." } };
      }
      const choice = await vscode.window.showQuickPick(folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.toString(),
        folderUri: folder.uri.toString(),
      })), { placeHolder: "Choose the exact workspace folder for read-only inspection", canPickMany: false });
      if (!choice) return undefined;
      const changed = topologyError();
      if (changed) return { error: changed };
      const selected = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === choice.folderUri);
      if (!selected) {
        return { error: { code: "workspace_root_changed", message: "The chosen workspace folder changed while the picker was open. Choose again explicitly." } };
      }
      const unsupported = folderError(selected);
      return unsupported ? { error: unsupported } : { path: normalize(selected.uri.fsPath) };
    },
    validate(path) {
      const error = topologyError();
      if (error) return error;
      const folder = vscode.workspace.workspaceFolders?.find((entry) => !folderError(entry)
        && normalize(entry.uri.fsPath) === normalize(path));
      return folder ? undefined : {
        code: "workspace_root_changed", message: "This bound root is no longer an approved local workspace folder. Choose again explicitly.",
      };
    },
    onDidChange(listener) {
      return vscode.Disposable.from(
        vscode.workspace.onDidChangeWorkspaceFolders(listener),
        vscode.workspace.onDidGrantWorkspaceTrust(listener),
      );
    },
  };
}
