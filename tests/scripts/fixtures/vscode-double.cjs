const folderListeners = new Set();
const trustListeners = new Set();
const editorListeners = new Set();
class Disposable {
  constructor(close) { this.close = close; }
  dispose() { this.close?.(); }
  static from(...values) { return new Disposable(() => values.forEach((value) => value.dispose())); }
}
const uri = (path) => ({ fsPath: path, scheme: "file", authority: "", toString: () => `file://${path}` });
const testUi = { pickers: [] };

function createQuickPick() {
  const accept = new Set();
  const hide = new Set();
  const picker = {
    items: [], selectedItems: [], visible: false, disposed: false,
    onDidAccept(handler) { accept.add(handler); return { dispose: () => accept.delete(handler) }; },
    onDidHide(handler) { hide.add(handler); return { dispose: () => hide.delete(handler) }; },
    show() { this.visible = true; testUi.pickers.push(this); },
    hide() { this.visible = false; for (const handler of [...hide]) handler(); },
    dispose() { this.visible = false; this.disposed = true; },
    answer(approved) {
      if (this.disposed) return false;
      this.selectedItems = [this.items[approved ? 1 : 0]];
      for (const handler of [...accept]) handler();
      return true;
    },
    cancel() { if (!this.disposed) this.hide(); },
  };
  return picker;
}
module.exports = {
  testUi,
  env: { clipboard: { async writeText() {} }, remoteName: undefined },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor(listener) { editorListeners.add(listener); return new Disposable(() => editorListeners.delete(listener)); },
    createQuickPick,
    async showSaveDialog() { return undefined; },
    async showQuickPick() { return undefined; },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    getWorkspaceFolder(resource) {
      return this.workspaceFolders.filter((folder) =>
        resource.scheme === folder.uri.scheme && resource.authority === folder.uri.authority
        && (resource.fsPath === folder.uri.fsPath || resource.fsPath.startsWith(`${folder.uri.fsPath}/`)))
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
    },
    fs: { async writeFile() {} },
    onDidChangeWorkspaceFolders(listener) { folderListeners.add(listener); return new Disposable(() => folderListeners.delete(listener)); },
    onDidGrantWorkspaceTrust(listener) { trustListeners.add(listener); return new Disposable(() => trustListeners.delete(listener)); },
  },
  Uri: { file: uri, joinPath: (base, ...paths) => uri(`${base.fsPath}/${paths.join("/")}`) },
  commands: { async executeCommand() {} },
  Disposable,
  __test: {
    foldersChanged() { for (const listener of folderListeners) listener(); },
    trustGranted() { for (const listener of trustListeners) listener(); },
    editorChanged() { for (const listener of editorListeners) listener(); },
    listenerCount() { return folderListeners.size + trustListeners.size + editorListeners.size; },
  },
};
