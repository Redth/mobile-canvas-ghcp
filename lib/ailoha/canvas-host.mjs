import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mobileErrorResult } from "./mobile-backend.mjs";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

const ASSETS = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/device-canvas.css": ["device-canvas.css", "text/css; charset=utf-8"],
  ...Object.fromEntries([
    "device-canvas", "canvas-state", "create-device-options", "ailoha-canvas-state",
    "ailoha-video-protocol", "ailoha-video-receiver", "ailoha-video-player",
  ].map((name) => [`/${name}.js`, [`${name}.js`, "text/javascript; charset=utf-8"]])),
});
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function equalSecret(left, right) {
  if (typeof left !== "string") return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      request.pause();
      finish(new MobileAilohaError("request_timeout", "Panel request body exceeded its deadline.", 408));
    }, 15_000);
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        request.pause();
        finish(new MobileAilohaError("request_too_large", "Panel JSON request exceeds 64 KiB.", 413));
      } else chunks.push(chunk);
    });
    request.once("end", () => {
      try { finish(null, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { finish(new MobileAilohaError("invalid_request", "Panel request is not valid UTF-8.", 400)); }
    });
    request.once("error", () => finish(new MobileAilohaError("request_failed", "Panel request could not be read.", 400)));
    request.once("aborted", () => finish(new MobileAilohaError("request_cancelled", "Panel request was cancelled.", 400)));
  });
}

export function createAilohaCanvasHost({
  scope,
  createBackend,
  assetRoot = join(dirname(fileURLToPath(import.meta.url)), "../../web"),
  onError = () => {},
}) {
  const capturedScope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
  const cookieName = `mobile_canvas_${randomBytes(16).toString("hex")}`;
  let current = null;
  let opening = null;
  let closing = Promise.resolve();
  let retiring = null;

  async function start() {
    const { WebSocket, WebSocketServer } = await import("ws");
    await closing;
    const browserSockets = new Set();
    const secret = randomBytes(32).toString("hex");
    let cookie = null;
    let retired = false;
    let port;
    let backend;
    let resuming = null;
    const websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has("ailoha.video.v1") ? "ailoha.video.v1" : false,
    });
    const report = (error) => onError(mobileErrorResult(error));
    const authorized = (request) => {
      const value = (request.headers.cookie ?? "").split(";")
        .map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
      return cookie !== null && equalSecret(value?.slice(cookieName.length + 1), cookie);
    };
    const local = (request) => {
      const peer = request.socket.remoteAddress;
      return !retired && (peer === "127.0.0.1" || peer === "::ffff:127.0.0.1")
        && request.headers.host === `127.0.0.1:${port}`
        && (request.headers.origin === undefined || request.headers.origin === `http://127.0.0.1:${port}`);
    };
    const event = (activity) => {
      const text = JSON.stringify(activity);
      for (const entry of browserSockets) {
        if (entry.channel === "events" && entry.socket.readyState === WebSocket.OPEN) {
          entry.socket.send(text, (error) => { if (error) report(new MobileAilohaError("panel_event_failed", "The owned panel event channel failed.", 502)); });
        }
      }
    };
    backend = await createBackend({ scope: capturedScope, onEvent: event, onError });
    try { await backend.ready(); }
    catch (error) {
      await backend.dispose();
      throw error;
    }
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        if (!local(request)) throw new MobileAilohaError("panel_origin_rejected", "Panel requests must use their own loopback authority.", 403);
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (request.method === "GET" && Object.hasOwn(ASSETS, url.pathname) && !url.search) {
          const [filename, contentType] = ASSETS[url.pathname];
          response.writeHead(200, {
            "Content-Type": contentType,
            "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(await readFile(join(assetRoot, filename)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/auth/bootstrap" && !url.search) {
          let input;
          try { input = JSON.parse(await readBody(request)); }
          catch { throw new MobileAilohaError("bootstrap_invalid", "Panel bootstrap must be valid JSON.", 400); }
          if (!equalSecret(input.secret, secret) || input.sessionId !== capturedScope.sessionId || input.instanceId !== capturedScope.viewId) {
            throw new MobileAilohaError("bootstrap_rejected", "The bootstrap grant does not belong to this panel.", 403);
          }
          cookie = randomBytes(32).toString("hex");
          response.writeHead(204, {
            "Set-Cookie": `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          }).end();
          return;
        }
        if (!authorized(request)) throw new MobileAilohaError("panel_unauthorized", "Bootstrap this owned panel before using its API.", 401);
        if (request.method === "POST" && !url.search && url.pathname === "/api/v1/canvas/suspend") {
          await backend.dispose();
          response.writeHead(204).end();
          return;
        }
        if (request.method === "POST" && !url.search && url.pathname === "/api/v1/canvas/resume") {
          if (backend.closed) {
            resuming ??= (async () => {
              await backend.dispose();
              const replacement = await createBackend({ scope: capturedScope, onEvent: event, onError, reason: "resume" });
              if (retired) {
                await replacement.dispose();
                throw new MobileAilohaError("view_closed", "This panel was retired during resume.");
              }
              try { await replacement.ready(); }
              catch (error) { await replacement.dispose(); throw error; }
              backend = replacement;
            })();
            const pending = resuming;
            try { await pending; }
            finally { if (resuming === pending) resuming = null; }
          }
          response.writeHead(204).end();
          return;
        }
        const body = request.method === "GET" ? undefined : await readBody(request);
        const result = await backend.request(`${url.pathname}${url.search}`, { method: request.method, body });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(result.body === null ? undefined : new Uint8Array(await result.arrayBuffer()));
      } catch (error) {
        const result = mobileErrorResult(error);
        onError(result);
        if (!response.headersSent) response.writeHead(result.status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify(result));
      }
    });
    server.requestTimeout = 65_000;
    server.headersTimeout = 15_000;
    server.on("upgrade", (request, socket, head) => {
      if (!local(request) || !authorized(request)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const channel = url.pathname === "/ws/video" ? "video" : url.pathname === "/ws/events" ? "events" : null;
      if (!channel || (channel === "video" && request.headers["sec-websocket-protocol"] !== "ailoha.video.v1")
        || [...url.searchParams.keys()].some((key) => channel !== "video" || key !== "deviceId")) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (browser) => {
        const entry = { socket: browser, channel, video: null, closeRequested: false };
        browserSockets.add(entry);
        const cleanup = async () => {
          entry.closeRequested = true;
          browserSockets.delete(entry);
          if (entry.video) await entry.video.close();
        };
        browser.on("close", () => { void cleanup().catch(report); });
        browser.on("error", () => {
          report(new MobileAilohaError("panel_socket_failed", "The owned panel socket failed.", 502));
          void cleanup().catch(report);
        });
        browser.on("message", (data, isBinary) => {
          if (channel !== "video" || isBinary || !entry.video) {
            browser.close(1008, "Unsupported panel control");
            return;
          }
          void entry.video.send(data.toString()).catch((error) => {
            report(error);
            browser.close(1011, "Owned video send failed");
          });
        });
        if (channel !== "video") return;
        const buffered = [];
        let bufferedBytes = 0;
        let initialized = false;
        const forward = (data) => {
          if (entry.closeRequested || retired) return;
          const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (!initialized) {
            if (buffered.length >= 32 || bufferedBytes + size > MAX_BUFFERED_BYTES) {
              throw new MobileAilohaError("video_buffer_limit", "The owned video startup buffer is full.", 502);
            }
            buffered.push(typeof data === "string" ? data : new Uint8Array(data));
            bufferedBytes += size;
          } else if (browser.readyState === WebSocket.OPEN) {
            if (browser.bufferedAmount + size > MAX_BUFFERED_BYTES) {
              throw new MobileAilohaError("panel_video_buffer_limit", "The owned browser delivery buffer is full.", 502);
            }
            browser.send(data, { binary: typeof data !== "string" }, (error) => {
              if (error) {
                report(new MobileAilohaError("panel_video_failed", "The owned panel could not receive a video unit.", 502));
                browser.close(1011, "Owned panel delivery failed");
              }
            });
          }
        };
        void (async () => {
          await backend.closeVideos();
          entry.video = await backend.openVideo(url.searchParams.get("deviceId"), forward, (error) => {
            onError(error);
            if (browser.readyState === WebSocket.OPEN) browser.close(1011, "Ailoha live transport failed");
          });
          if (entry.closeRequested || retired) {
            await entry.video.close();
            return;
          }
          browser.send(JSON.stringify({
            type: "mobile-canvas-video",
            context: entry.video.context,
            geometry: entry.video.geometry,
            ...(entry.video.source !== undefined ? { source: entry.video.source } : {}),
            ...(entry.video.sourceDetail !== undefined ? { sourceDetail: entry.video.sourceDetail } : {}),
          }));
          initialized = true;
          for (const data of buffered) forward(data);
          buffered.length = 0;
        })().catch((error) => {
          report(error);
          if (browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify(mobileErrorResult(error)));
            browser.close(1011, "Owned video unavailable");
          }
        });
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      await backend.dispose();
      throw error;
    }
    port = server.address().port;
    let closeTask;
    const entry = {
      get backend() { return backend; },
      openResult: Object.freeze({
        title: "Mobile",
        cookieName,
        url: `http://127.0.0.1:${port}/#${new URLSearchParams({
          bootstrap: secret, sessionId: capturedScope.sessionId, instanceId: capturedScope.viewId,
        })}`,
      }),
      close() {
        return closeTask ??= (async () => {
          retired = true;
          for (const entry of browserSockets) entry.socket.terminate();
          let failure;
          if (resuming) {
            try { await resuming; }
            catch (error) { onError(mobileErrorResult(error)); }
          }
          try { await backend.dispose(); }
          catch (error) { failure = error; }
          await new Promise((resolve) => server.close(resolve));
          websocketServer.close();
          if (failure) throw failure;
        })().catch((error) => {
          closeTask = null;
          throw error;
        });
      },
    };
    return entry;
  }

  async function connected() {
    if (current) return current;
    const pending = opening ??= start();
    try {
      const entry = await pending;
      if (opening === pending) current = entry;
      return entry;
    } catch (error) {
      if (opening === pending) opening = null;
      throw error;
    }
  }

  function closeCanvas() {
      const pending = opening;
      const active = current ?? retiring;
      current = null;
      opening = null;
      const previousClosing = closing;
      closing = (async () => {
        try { await previousClosing; }
        catch (error) { onError(mobileErrorResult(error)); }
        const entry = active ?? retiring ?? (pending ? await pending : null);
        if (entry) {
          retiring = entry;
          await entry.close();
          if (retiring === entry) retiring = null;
        }
      })();
      return closing;
  }

  const host = {
    scope: capturedScope,
    async openCanvas(input = {}) {
      if (current?.backend.closed) await closeCanvas();
      const entry = await connected();
      if (input.deviceId !== undefined) await entry.backend.select(input.deviceId, input);
      return entry.openResult;
    },
    async invokeAction(name, input) {
      const entry = current ?? (opening ? await opening : null);
      if (!entry || entry.backend.closed) {
        throw new MobileAilohaError("view_closed", "Open the named Ailoha canvas before invoking an action; background requests cannot reopen it.");
      }
      return entry.backend.invokeAction(name, input);
    },
    closeCanvas,
  };
  Object.defineProperty(host, "connectionRef", {
    get: () => (current ?? retiring)?.backend.connectionRef,
  });
  return Object.freeze(host);
}
