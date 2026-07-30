# Using Mobile Canvas from VS Code

The Copilot app surfaces Mobile Canvas as a canvas panel. VS Code has no canvas
API, but it does speak MCP — so the same 24 device tools work in Copilot Chat's
agent mode with no additional code.

## Setup

Copy [`.vscode/mcp.json`](../.vscode/mcp.json) into your project (or add the
same entry to your user-level `mcp.json` to enable it everywhere):

```json
{
  "servers": {
    "mobile-canvas": {
      "type": "stdio",
      "command": "mobile-canvas",
      "args": ["mcp"]
    }
  }
}
```

If `mobile-canvas` is not on your `PATH`, use an absolute path — for example the
copy bundled with the Copilot extension:

```json
"command": "${userHome}/.copilot/extensions/mobile-canvas/bin/mobile-canvas"
```

Open Copilot Chat, switch to **Agent** mode, and the `mobile_device_*` tools
appear in the tool picker.

## What you get

Everything except the live video panel:

```
"Boot an iPhone 16 simulator and tell me its UDID"
"Take a screenshot of the booted Android emulator"
"Tap at 200,400 then swipe up"
```

`mobile_device_screenshot` returns a real image content block, so the agent can
actually look at the device between actions. That covers most of what the canvas
gives you visually — the canvas is better for continuous interaction, MCP is
better for scripted flows.

## Running both at once

This is supported and is the normal setup.

The MCP server is a **thin client of the shared background host**, not a second
copy of it. `mobile-canvas mcp` speaks stdio to the editor and HTTP to the same
per-user host that serves the canvas, so the canvas panel in the Copilot app and
the MCP tools in VS Code operate on one consistent view of your devices.

Selection is scoped per canvas panel, so an MCP client and a canvas panel can
each target a different device without fighting.

## Notes on a future VS Code extension

A dedicated extension is not required for tool access and is not shipped today.
If one is added later, the useful hooks are:

- `vscode.lm.registerMcpServerDefinitionProvider(id, provider)` plus a
  `contributes.mcpServerDefinitionProviders` entry, to register the server
  automatically instead of asking users to write `mcp.json`. Requires engine
  `^1.101.0`.
- A webview for the live video. A raw `<iframe src="http://127.0.0.1:...">` is
  blocked by webview CSP; the working shape is to bundle the HTML in the
  extension and let it `fetch`/`WebSocket` to loopback with
  `connect-src http://127.0.0.1:* ws://127.0.0.1:*`.

Two gotchas worth recording:

- The docs page shows an object-literal constructor for
  `McpStdioServerDefinition`, but `vscode.d.ts` defines a **positional** one:
  `(label, command, args?, env?, version?)`, with `cwd` set as a property after
  construction. Trust `vscode.d.ts` for your target engine.
- `asExternalUri` is a no-op on desktop. It only matters for Remote SSH,
  Codespaces, and vscode.dev — none of which can reach a local simulator anyway.
