# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from repository evidence and the current brief: developers and coding agents inspecting,
testing, and automating local mobile devices and Windows applications without leaving GitHub Copilot
or VS Code.

## Product Purpose

Mobile Canvas gives a person and an agent the same local visual target, live state, semantic
inspection, and interaction controls. Success means the user can understand what the agent sees,
follow what it does, and take over without switching tools.

## Positioning

The product combines a live, human-operable canvas with the same scoped automation capabilities
exposed to the agent. The canvas is not merely a test runner or a remote-desktop viewer.

## Operating Context

The UI runs as a loopback-hosted canvas in the GitHub Copilot app and as a VS Code webview. Windows
App sessions can launch or attach to local processes, switch between their windows, inspect UI
Automation, stream capture, and fall back to screenshot-guided input.

## Capabilities and Constraints

- Shared behavior must remain in `web/`; host adapters stay isolated.
- Canvas controls and agent tools must target opaque, panel-scoped identifiers rather than HWNDs.
- UI Automation is the semantic, background-capable path; raw pointer and keyboard fallback may
  require foreground control.
- Both light/dark host themes, narrow side panels, keyboard navigation, loading, empty, ambiguous,
  permission, and failure states are required.
- Inferred decision for this task: inspector queries use AND-only clauses; plain text means
  `name contains`; richer Boolean grouping remains deliberately out of scope.

## Product Principles

- Human and agent state must agree.
- Prefer semantic actions over pixel guesses.
- Make degraded modes and security boundaries visible.
- Progressive disclosure for power without making first use feel like a test harness form.
- Preserve user control and explain every failure in actionable language.

## Accessibility & Inclusion

All primary workflows must be keyboard-operable, retain visible focus, expose meaningful accessible
names and live status, support high-contrast host themes, and remain usable in narrow panels and at
text zoom.
