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
  env: { clipboard: { async writeText() {} } },
  window: { createQuickPick, async showSaveDialog() { return undefined; } },
  workspace: { workspaceFolders: [], fs: { async writeFile() {} } },
  Uri: { file: (path) => ({ fsPath: path }), joinPath: (base, path) => ({ fsPath: `${base.fsPath}/${path}` }) },
};
