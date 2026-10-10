module.exports = {
  env: { clipboard: { async writeText() {} } },
  window: { async showSaveDialog() { return undefined; } },
  workspace: { workspaceFolders: [], fs: { async writeFile() {} } },
  Uri: { file: (path) => ({ fsPath: path }), joinPath: (base, ...paths) => ({ fsPath: `${base.fsPath}/${paths.join("/")}` }) },
};
