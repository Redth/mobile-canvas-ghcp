import * as vscode from "vscode";

export interface DestructivePrompt {
  (request: { readonly title: string; readonly message: string }, options: {
    readonly signal: AbortSignal;
  }): Promise<boolean | "cancel">;
  readonly isSupported: () => boolean;
}

export function createDestructivePrompt(): DestructivePrompt {
  return Object.freeze(Object.assign(
    (request: { readonly title: string; readonly message: string }, { signal }: { readonly signal: AbortSignal }) =>
      new Promise<boolean | "cancel">((resolve) => {
        const picker = vscode.window.createQuickPick();
        const deny = { label: "Do not proceed", description: "No device changes" };
        const approve = { label: "Approve once", description: request.title, detail: request.message };
        picker.title = request.title;
        picker.placeholder = "Review the captured target and choose whether to proceed";
        picker.items = [deny, approve];
        picker.canSelectMany = false;
        picker.ignoreFocusOut = false;
        let finished = false;
        const subscriptions: vscode.Disposable[] = [];
        const finish = (value: boolean | "cancel") => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          for (const subscription of subscriptions) subscription.dispose();
          picker.hide();
          picker.dispose();
          resolve(value);
        };
        const onAbort = () => finish("cancel");
        subscriptions.push(
          picker.onDidAccept(() => finish(picker.selectedItems.length === 1 && picker.selectedItems[0] === approve)),
          picker.onDidHide(() => finish("cancel")),
        );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish("cancel");
        else picker.show();
      }),
    { isSupported: () => typeof vscode.window.createQuickPick === "function" },
  ));
}
