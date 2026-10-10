import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const mappings = Object.freeze({
  "/source/": join(root, "web"),
  "/github/": join(root, ".build/copilot-plugin-thin/mobile-canvas/web"),
  "/vscode/": join(root, "vscode/dist/web"),
  "/fixtures/": join(root, "tests/web/fixtures/ailoha-baseline"),
  "/fixtures-bframes/": join(root, "tests/web/fixtures/ailoha-bframes"),
  "/tests/": join(root, "tests/web"),
});
const html = `<!doctype html><meta charset="utf-8"><title>Ailoha synthetic WebCodecs check</title>
<script type="module">
import { runAilohaPlayerBrowserCheck } from "/tests/ailoha-player-browser-check.js";
const host = new URLSearchParams(location.search).get("host") || "source";
const media = new URLSearchParams(location.search).get("media") || "baseline";
if (!["source", "github", "vscode"].includes(host)) throw new Error("Invalid prepared host");
if (!["baseline", "bframes"].includes(media)) throw new Error("Invalid synthetic media fixture");
window.check = import("/" + host + "/ailoha-video-player.js").then(({ createAilohaVideoPlayer }) =>
  runAilohaPlayerBrowserCheck(createAilohaVideoPlayer, media));
window.check.then(result => {
  window.result = result;
  document.body.append(document.createTextNode(JSON.stringify(result)));
}, error => {
  window.result = { passed: false, message: error.message };
  document.body.append(document.createTextNode(JSON.stringify(window.result)));
});
</script>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
    return;
  }
  if (path === "/health") {
    response.end("ready");
    return;
  }
  const entry = Object.entries(mappings).find(([prefix]) => path.startsWith(prefix));
  const filename = entry ? path.slice(entry[0].length) : "";
  if (!entry || !/^[a-zA-Z0-9.-]+\.(js|json|alhv|png|yuv)$/.test(filename)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(join(entry[1], filename));
    const type = filename.endsWith(".js") ? "text/javascript"
      : filename.endsWith(".json") ? "application/json"
        : filename.endsWith(".png") ? "image/png" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(bytes);
  } catch (error) {
    response.writeHead(404).end();
    process.stderr.write(`Synthetic browser fixture unavailable: ${error.code}\n`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(`http://127.0.0.1:${server.address().port}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
