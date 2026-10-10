const folderListeners = new Set();
const trustListeners = new Set();
class Disposable {
  constructor(close) { this.close = close; }
  dispose() { this.close?.(); }
  static from(...values) { return new Disposable(() => values.forEach((value) => value.dispose())); }
}
const uri = (path) => ({ fsPath: path, scheme: "file", authority: "", toString: () => `file://${path}` });
module.exports = {
  env: { clipboard: { async writeText() {} }, remoteName: undefined },
  window: {
    async showSaveDialog() { return undefined; },
    async showQuickPick() { return undefined; },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    fs: { async writeFile() {} },
    onDidChangeWorkspaceFolders(listener) { folderListeners.add(listener); return new Disposable(() => folderListeners.delete(listener)); },
    onDidGrantWorkspaceTrust(listener) { trustListeners.add(listener); return new Disposable(() => trustListeners.delete(listener)); },
  },
  Uri: { file: uri, joinPath: (base, ...paths) => uri(`${base.fsPath}/${paths.join("/")}`) },
  Disposable,
  __test: {
    foldersChanged() { for (const listener of folderListeners) listener(); },
    trustGranted() { for (const listener of trustListeners) listener(); },
    listenerCount() { return folderListeners.size + trustListeners.size; },
  },
};
