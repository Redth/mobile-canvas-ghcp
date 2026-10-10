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
      const key = message.requestId ?? message.id;
      let timer;
      if (message.type === "socket-send") {
        if ([...pending.values()].filter((entry) => entry.socketId).length >= 32) {
          reject(new Error("The bounded video control queue is full."));
          return;
        }
        timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error("The owned video control send exceeded its deadline."));
        }, 30_000);
      }
      pending.set(key, { resolve, reject, timer, socketId: message.type === "socket-send" ? message.id : undefined });
      vscode.postMessage(message);
    });
  }

  function completePending(key, value, error) {
    const entry = pending.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    pending.delete(key);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  function rejectSocketRequests(socketId) {
    for (const [key, entry] of pending) {
      if (entry.socketId === socketId) completePending(key, undefined, new Error("The owned video channel was closed."));
    }
  }

  class BridgeSocket extends EventTarget {
    constructor(channel, query) {
      super();
      this.id = id();
      this.readyState = WebSocket.CONNECTING;
      this.binaryType = "arraybuffer";
      this.protocol = "";
      sockets.set(this.id, this);
      vscode.postMessage({
        type: "socket-open",
        id: this.id,
        channel,
        query: query ? String(query) : undefined,
      });
    }

    send(data) {
      if (this.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("The owned video channel is not open."));
      }
      return request({ type: "socket-send", id: this.id, requestId: id(), data });
    }

    close() {
      if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
        return this.closePromise;
      }
      this.readyState = WebSocket.CLOSING;
      rejectSocketRequests(this.id);
      if (this.protocol === "ailoha.video.v1") {
        this.closePromise = new Promise((resolve, reject) => {
          this.finishClose = resolve;
          this.closeTimer = setTimeout(() => reject(new Error("The owned video close exceeded its deadline.")), 30_000);
        });
      }
      vscode.postMessage({ type: "socket-close", id: this.id });
      return this.closePromise;
    }

    opened(protocol = "") {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.protocol = protocol;
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
      rejectSocketRequests(this.id);
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
      this.finishClose?.();
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "context":
        context = { sessionId: message.sessionId, instanceId: message.instanceId };
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
        completePending(message.id,
          new Response(message.body, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }),
        );
        break;
      case "api-error":
      case "operation-error":
        completePending(message.id, undefined, new Error(message.message));
        break;
      case "operation-result":
        completePending(message.id, message);
        break;
      case "socket-opened":
        sockets.get(message.id)?.opened(message.protocol);
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
