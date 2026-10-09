# Mobile Canvas and Ailoha integration roadmap

**Status:** Approved roadmap; implementation has not cut over to Ailoha.

**Approved:** 2026-10-09

**Compatibility baseline:** [Mobile Canvas compatibility baseline](compatibility-baseline.md)

## Product direction

Keep **Mobile Canvas** as the product developers install and use: live devices,
direct interaction, and an agent working on the same device the developer sees.
Adopt **Ailoha** as the reusable engine for device providers, target control,
optional app-agent operations, capability routing, CLI/MCP services, onboarding
recipes, and skills.

An app agent is an optional capability upgrade, never a prerequisite for opening
a simulator, installing an ordinary app, or controlling its system UI. Preserve
the current Mobile Canvas product identity and public interfaces through a
deliberate migration adapter; do not install a parallel “Ailoha Targets” product
or silently replace the current contract. This roadmap changes the prior
replacement-without-compatibility-shim direction. It does not itself implement
the migration.

## Ownership and boundaries

| Owner | Responsibility |
| --- | --- |
| Ailoha | Reusable Target Host, provider contracts and implementations, native helpers, optional app agents and composed app operations, capability contracts, runtime acquisition, framework onboarding recipes, and core skills. |
| Mobile Canvas | Product identity, device/app presentation, onboarding UX, inspection lenses, action feedback, evidence presentation, and GitHub/VS Code host adaptation. |
| Existing development tooling | Framework builds, deployment, debugging, hot reload, and project-system integration. Reuse existing MAUI DevFlow and VS Code tasks/debug adapters where available. |
| Broker | Service discovery and identity only. No workspace scanning, simulator commands, traffic proxy, credentials, or onboarding logic. |

Keep behavior shared by the GitHub Copilot canvas and VS Code extension in
shared product modules; isolate host adapters and styling. High-frequency video
and input stay on the Target Host HTTP/WebSocket transport. Semantic and
diagnostic app operations use Ailoha's canonical operation implementation, not
a second JavaScript policy stack. Do not launch a CLI for each pointer event or
video frame, and do not put MCP clients, native process launchers, or credentials
in a renderer.

## Experience and execution contracts

Present capabilities by evidence and operation, not by framework name or the
mere presence of an installed package:

| Layer | Examples | App instrumentation |
| --- | --- | --- |
| Device and OS | Inventory, lifecycle, install/launch, display, screenshots, recordings, coordinate input, system accessibility, permissions, logs, and device configuration. | Not required; support varies by provider. |
| Optional app agent | Framework-aware tree/properties, stable app identifiers, app navigation/state, app-captured diagnostics, supported storage, WebViews, and extensions. | Requires a connected, correctly correlated agent that advertises the requested operation. |
| Workspace | Identify apps, inspect setup, propose an integration plan, find existing launch workflows, and verify debug-only behavior. | Inspection requires neither a running app nor an agent. |

Use per-operation capability evidence. An installed agent need not be running; a
registered agent need not be correlated to the selected target; a connected agent
need not implement every operation. Semantic actions may prefer a capable,
correctly correlated app agent. Device/system actions remain owned by the device
provider. Fall back only when the agent is absent or explicitly lacks a
capability, never after an operation fails or times out.

Expose separate **App** and **System** inspection lenses. The system lens remains
available for permission dialogs, launchers, keyboards, and UI outside an
instrumented app. Label the source of every tree/result. Never route an app-agent
element handle to a system UI endpoint after the agent disconnects. Element
handles must retain their owner and app/process incarnation; coordinate actions
must retain the observed geometry revision and logical coordinate space.

Use the existing view-scoped selection as the starting point, not a global
selected application. A shared context should bind the workspace/application to
the selected target host, target, surface, optional agent, and selection
revision, adding process incarnation and geometry when required. Each operation
captures an immutable context so a later panel selection cannot retarget an
in-flight action, recording stop, or delayed result. The product bridge remains
the view's selection authority; tools either read a named context or receive
explicit selectors. Standalone CLI sessions retain explicit-selection behavior.
Keep machine-neutral workspace preferences separate from private local runtime
state; never commit ports, credentials, bootstrap tokens, or machine/device IDs.

Correlation requires target-host identity, target identity, and intended
application; package name, project path, or port alone is insufficient. Adopt a
manually launched agent only when evidence matches, and show ambiguity rather
than choosing the first agent. The broker's existing project/TFM registration
IDs must continue to work while any runtime-instance identity is introduced
through a versioned additive path.

## Workspace inspection and consented onboarding

Expose the existing project detector as a bounded, read-only structured service.
Report individual applications (including monorepos), framework/variant,
platforms, manifest evidence, agent dependencies and startup wiring, supported
capabilities, launch profiles, and concrete missing steps. Add Swift/Xcode
detection. Ignore generated/vendor trees, respect trust and exclusions, avoid
symlink escapes, debounce watchers, and do not run arbitrary build/package hooks
just to classify a workspace. Generated Expo/Flutter folders must not become
duplicate app recommendations.

Keep inspection separate from modification. The workflow is:

1. Inspect and select the intended application.
2. Preview the framework-specific plan and proposed edits.
3. Obtain user approval before applying changes.
4. Use existing coding/build/deploy tools.
5. Verify a real agent connection to the intended target and perform a small
   semantic smoke action.
6. Confirm production instrumentation is absent or disabled as required by the
   framework.

Recipes declare supported versions, detection evidence, dependencies, setup
instructions/transforms, rebuild steps, debug/release rules, and success checks.
Handle framework-specific cases such as Expo Go versus development builds, MAUI
conditional dependencies, Android debug/no-op wiring, Swift lifecycle startup,
and React Native native rebuilds. Do not enable hooks, log capture, profiling,
or sensitive storage wholesale. Make setup idempotent, preserve dirty and
user-owned files, report partial completion, and only remove/update attributable
managed changes while preserving local edits. Installing skills with
`ailoha init` is not app-agent installation or app configuration.

## CLI, MCP, and skills

Keep one canonical Ailoha tool implementation. Mobile Canvas should expose a
scoped product profile and thin, explicit adapters for the existing
`mobile_device_*` MCP tools and canvas actions. Map through real target inventory
and host scope, reject ambiguity, and preserve destructive confirmations and
output semantics. Do not allow system-tree IDs to become app-agent IDs. Avoid
permanently enabling every old and canonical duplicate by default; deprecate
deliberately and remove compatibility only after replacement coverage is
complete.

Provide an always-available device workflow and capability-routing guide plus
on-demand onboarding/debugging skills for detected frameworks. Reuse existing
framework guidance and add Swift/Xcode coverage. Teach callers to query before
requesting a giant tree, prefer stable identifiers over coordinates, retain
source provenance and geometry revisions, distinguish unsupported capability
from operational failure, and capture evidence. Verify examples against actual
schemas and runtime versions. Use native plugin skill delivery where supported;
for VS Code use a supported integration or an explicit, user-approved install
to the intended project/personal scope. Do not silently edit global chat
settings. Keep managed skills deduplicated without overwriting user edits.

## Runtime, distribution, and licensing gates

Replace the Mobile Canvas runtime launcher only with an Ailoha-owned resolver
that can use a verified installed artifact, reuse a compatible host, start one
when needed, and report provider/SDK failures clearly. Concurrent product
windows must not spawn competing default hosts. Distinguish product-owned
processes from external processes; closing a panel must never stop an external
host or simulator. Finalize owned recordings and release stream/input grants
before idle runtime cleanup.

Production runtime, client, and skill dependencies must be exact versions of
publicly obtainable, provenance-checked artifacts. A source merge, release-job
definition, or anonymous package lookup is not proof that every required
artifact is publicly downloadable and tested. Normal product installation must
not require a sibling checkout, private feed/registry credential, local SDK
build, `file:` dependency, or .NET SDK for device runtime use. Release
publication remains a separate decision.

**Licensing is unresolved and blocks Ailoha source changes and redistribution.**
Mobile Canvas is MIT; Ailoha has a restrictive source-available license. No
authorization to modify or redistribute Ailoha-owned source, UI, schemas,
skills, or binaries has been established. Public download availability or
maintainer overlap is not permission. Before integration or release, obtain
explicit rights covering the shared bridge/UI, runtime embedding, skill
distribution, and provider contributions. Do not vendor Ailoha source into this
repository, change license notices, or infer a grant. Mobile Canvas-owned
documentation and compatibility work does not resolve this gate.

## Delivery sequence and exit criteria

| Slice | Deliverable | Required gate |
| --- | --- | --- |
| 0. Contract and distribution | Ownership/licensing decision, capability/action map, pinned runtime/client/skill manifests, and publication plan. | Exact production artifacts and rights are identified; no private/source-checkout dependency. |
| 1. Agentless product migration | Both hosts use the shared Ailoha bridge and Target Host with compatible host reuse/startup and explicit Mobile Canvas adapters. | Fresh public install controls ordinary uninstrumented apps; full device workflow, recording, and lifecycle parity in both hosts. |
| 2. Shared app context | Scoped UI/MCP/CLI context, composed app operations, actual semantic inspection, provenance UX, and instance-safe correlation. | Tools operate on the same visible app; two views/workspaces and one app on two targets cannot cross-route. |
| 3. Workspace discovery | Structured per-app inspection, integration status, launch-profile discovery, Swift detection, and relevant upgrade UX. | Monorepo fixtures are accurate; opening a workspace neither edits files nor executes project hooks. |
| 4. Verified onboarding | First MAUI and Expo end-to-end recipes, then Flutter, Android, Swift, WinUI, and WPF; supported native skill delivery. | Approved setup reaches the intended running agent, preserves user edits, and respects release instrumentation rules. |
| 5. Desktop and remote | Explicit desktop capability matrices and remote-workspace execution/connection adapters. | OS-specific workflows and topology/security boundaries are exercised; remote loopback is not confused with local device-host loopback. |
| 6. Retire duplicate ownership | Remove legacy device implementation from product execution and redundant registrations; formalize upstream contribution. | No regression remains, compatibility policy is explicit, and providers have one canonical owner. |

Workspace discovery may proceed alongside agentless migration once its contract
is settled. Production onboarding depends on the context and connection path,
not detection alone. The first end-to-end demonstration should control an
ordinary MAUI or Expo app, obtain approval for an enhancement, rebuild through
existing tooling, verify semantic inspection, and have MCP operate on that same
app in both product hosts.

Acceptance coverage must include fresh public installs without developer
credentials/SDKs; one unavailable platform while the other remains usable;
runtime version skew and concurrent startup; missing/disconnected agents;
ambiguous/mismatched correlation; process restart; two views/workspaces and the
same app on two devices; stale element/geometry/context revisions; recording
completion on selection/close/detach; destructive confirmation; dirty
monorepos; declined or already-installed onboarding; and debug/release behavior.

The success criterion is not the number of aliases: Mobile Canvas must remain
useful for arbitrary apps, demonstrably gain capabilities for an instrumented
app, and use the same independently consumable Ailoha engine.
