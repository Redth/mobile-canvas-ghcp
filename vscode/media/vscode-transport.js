(function () {
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  const sockets = new Map();
  let context = null;
  let contextPromise = null;
  let resolveContext = null;
  let rejectContext = null;
  let visibilityHandler = null;
  let refreshHandler = null;
  let automationHandler = null;
  let refreshPending = false;
  const queuedAutomation = [];

  function id() {
    return crypto.randomUUID();
  }

  function request(message) {
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      vscode.postMessage(message);
    });
  }

  class BridgeSocket extends EventTarget {
    constructor(channel, query) {
      super();
      this.id = id();
      this.readyState = WebSocket.CONNECTING;
      this.binaryType = "arraybuffer";
      sockets.set(this.id, this);
      vscode.postMessage({
        type: "socket-open",
        id: this.id,
        channel,
        query: query ? String(query) : undefined,
      });
    }

    close() {
      if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
        return;
      }
      this.readyState = WebSocket.CLOSING;
      vscode.postMessage({ type: "socket-close", id: this.id });
    }

    opened() {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }

    message(data) {
      if (this.readyState !== WebSocket.OPEN) return;
      this.dispatchEvent(new MessageEvent("message", { data }));
    }

    error() {
      this.dispatchEvent(new Event("error"));
    }

    closed(code, reason) {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      sockets.delete(this.id);
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "context":
        context = {
          sessionId: message.sessionId,
          instanceId: message.instanceId,
          surface: message.surface || "mobile",
        };
        resolveContext?.(context);
        resolveContext = null;
        rejectContext = null;
        break;
      case "fatal":
        rejectContext?.(new Error(message.message));
        rejectContext = null;
        resolveContext = null;
        break;
      case "api-result":
        pending.get(message.id)?.resolve(
          new Response(message.body, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }),
        );
        pending.delete(message.id);
        break;
      case "api-error":
      case "operation-error":
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        break;
      case "operation-result":
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
        break;
      case "socket-opened":
        sockets.get(message.id)?.opened();
        break;
      case "socket-message":
        sockets.get(message.id)?.message(message.data);
        break;
      case "socket-error":
        sockets.get(message.id)?.error();
        break;
      case "socket-closed":
        sockets.get(message.id)?.closed(message.code, message.reason);
        break;
      case "visibility":
        visibilityHandler?.(message.visible);
        break;
      case "refresh":
        if (refreshHandler) refreshHandler();
        else refreshPending = true;
        break;
      case "automation":
        if (automationHandler) {
          automationHandler(message.activity);
        } else {
          queuedAutomation.push(message.activity);
          if (queuedAutomation.length > 32) queuedAutomation.shift();
        }
        break;
    }
  });

  window.mobileCanvasTransport = {
    async bootstrap() {
      if (context) return context;
      if (!contextPromise) {
        contextPromise = new Promise((resolve, reject) => {
          resolveContext = resolve;
          rejectContext = reject;
          vscode.postMessage({ type: "ready" });
        });
      }
      return contextPromise;
    },

    api(path, options = {}) {
      const requestId = id();
      return request({
        type: "api",
        id: requestId,
        path,
        method: options.method || "GET",
        body: options.body,
      });
    },

    createSocket(channel, query) {
      return new BridgeSocket(channel, query);
    },

    async copyText(text) {
      await request({ type: "copy", id: id(), text });
    },

    async saveBlob(blob, suggestedName) {
      const result = await request({
        type: "save",
        id: id(),
        suggestedName,
        bytes: await blob.arrayBuffer(),
      });
      return !result.cancelled;
    },

    setViewTitle(title, description) {
      vscode.postMessage({ type: "view-title", title, description });
    },

    onVisibilityChanged(handler) {
      visibilityHandler = handler;
    },

    onRefreshRequested(handler) {
      refreshHandler = handler;
      if (refreshPending) {
        refreshPending = false;
        refreshHandler();
      }
    },

    onAutomationRequested(handler) {
      automationHandler = handler;
      for (const activity of queuedAutomation.splice(0)) {
        automationHandler(activity);
      }
    },
  };
})();
