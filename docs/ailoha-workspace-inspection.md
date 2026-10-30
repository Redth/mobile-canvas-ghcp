# Read-only workspace evidence

This source-only Ailoha opt-in adds application/evidence cards to the shared
Mobile Canvas renderer, used by the GitHub App canvas and VS Code. Legacy
remains the default. This does **not** add onboarding, installation,
instrumentation edits, app/device actions, live probing, or application
selection.

## Canonical contract

The host calls only the verified official SDK launch
`getVerifiedCliLaunch({ expectedVersion })`, then executes:

```text
ailoha workspace inspect --path <explicit-absolute-root> --json
ailoha workspace inspect --path <explicit-absolute-root> --json --exclude <pattern>
```

The shared controller uses `ailoha.workspace.inspection/v1`, grounded in
[the landed upstream contract](https://github.com/microsoft/ailoha/blob/f83f3b976165e2a83f63d85310edbac24b0a9dd6/docs/workspace-inspection.md)
and its serialized DTOs. CLI exit 2 is accepted only with structured,
incomplete canonical output. Other process failures are explicit errors.
One invocation per view is allowed at a time, with a 30-second deadline and
2 MiB output limit; the canonical scanner's no-follow traversal, exclusions,
ignore policy, limits and diagnostics remain authoritative. No consumer
scanner or native/runtime implementation is copied.

`lib/ailoha/workspace-inspection.mjs` validates the schema, complete output
shape, enums, relative evidence paths, counts, unique opaque app identities,
and the returned root before projecting a bounded immutable view. Unknown
fields are not forwarded. `nativeTarget` and wrapper target metadata are
additive nullable v1 fields. Applications sharing a manifest or bundle ID
remain separate by their upstream `applicationId` and native target ID.

The cards show application/library/unknown role, framework, variant,
platforms, target identity, native wrapper ownership, dependency declaration,
known startup/debug syntax, source locations, and scan coverage/diagnostics.
Declared is not installed, observed startup syntax is not execution, and
debug syntax is not verified release stripping. Live connection/correlation
are `not-evaluated`; live capabilities remain explicit `null`. Full build
evaluation, SwiftPM GUI classification, xcconfig/includes and dynamic wrapper
ownership are not inferred. An incomplete scan is not a successful empty
result or proof of absent instrumentation.

Expanded evidence details retain the scanner's concrete `missingSteps` codes
and explanations as read-only setup review suggestions, explicitly requiring
approval and workspace mutation before any change. `recommendedSkillIds` are
informational text only: they are not install commands, buttons, verified
availability or public package claims. No missing step or skill ID is inferred
for an application, library, unknown role or incomplete scan.

## Root authority and lifecycle

| Host | Project root policy |
| --- | --- |
| GitHub canvas | `workspaceRoot` and optional `workspaceExclusions` in the opt-in open input, or `workspace_inspect({ path, exclusions? })`. These provider calls are the root authority. No ambient cwd, first folder or parent root is used. The inspected SDK includes an optional `session.workingDirectory` hint, but this adapter has no established trust/topology contract for that hint and deliberately does not adopt it. |
| VS Code | A sole trusted local workspace folder is inferred automatically. In multi-root windows, the active editor's containing workspace folder is used when unambiguous; **Choose project** can explicitly choose another root or resolve ambiguity through the native picker. An empty window shows **No folder open** and a native **Open folder** action, never an artifact/session-directory guess. The root must remain an actual trusted local `file:` workspace folder when bound and when a scan runs/completes. No all-roots union or first-folder fallback is used. Remote windows, URI authorities and non-file folders remain unsupported. |

The bound absolute root is always displayed. Renderer requests to
`/api/v1/workspace/inspection` may capture only the displayed `generation`;
they cannot change root, exclusions, view/host identity, application ID or
context selection. A stale generation is rejected before scanning another
root. The VS Code-only `/api/v1/workspace/root` bridge route opens the native
picker when needed; `/api/v1/workspace/open` invokes VS Code's native Open Folder
command. Neither accepts a renderer path. These routes do not require a
device/context connection to inspect.

Root changes, workspace/trust events, selection intents, context errors,
cancel, hide, close, detach and bridge replacement retire pending evidence.
Cancellation is passed to the one-shot verified process; results that arrive
after retirement cannot paint a new card. Closing waits are not a reason to
launch overlapping scan processes. Resume requires an explicit new inspection
and does not replay an old scan. Root choices and scan results are not
persisted in preferences.

The shared **Workspace** and **Live inspection** panels are optional context,
not prerequisites for device controls. Both start collapsed and can be expanded
and resized independently. Resize handles support pointer drag, Arrow keys,
Home and End; collapse buttons support the native Enter/Space behavior.
Only collapsed state and bounded panel dimensions are persisted under the
existing host/view preference identity. Panel collapse/resize does not retire
inspection results, bindings, selection or leases, and panel input never
becomes device input. Narrow windows stack the panels below the device.

Workspace reads project files to identify applications and setup details; it
does not identify a running app agent. Native-instance binding remains a separate,
explicit Live inspection action. VS Code folder/trust changes retire pending
results before inference is reconsidered; changing the active editor to another
workspace folder also rebinds and retires the previous generation. Moving within
the same folder does not discard its results. Inspection itself remains an
explicit read rather than an automatic scan.

The host's unbound-root diagnostic (including **No folder open**) belongs to
root authority, not a transient scan result. Startup, invalidation and
hide/resume retain it until a new root binding or native folder/topology
decision replaces it. The renderer therefore keeps **Open folder** available
without requiring a failed **Choose project** round-trip. A genuinely
ambiguous multi-root workspace still uses **Choose project**; a null root
alone is never treated as proof that no folder is open.

Card details use local semantic `details`/`summary` controls and text nodes.
Opening details never changes device selection, broker/agent selection or
the canonical context revision. No install/enable action or automatic
suggestion of an obtainable agent package is exposed.

## Source-bound verification

The existing preparers copy the same host controller and renderer into both
products. The 24 legacy canvas actions/default registration and 61 legacy
MCP identifiers remain unchanged. Ailoha opt-in adds only the
`workspace_inspect` canvas action; the legacy MCP dispatcher is not a generic
Ailoha forwarder.

```sh
npm run build --prefix vscode
node scripts/prepare-plugin.mjs --thin
node --test tests/scripts/ailoha-workspace-inspection.test.mjs \
  vscode/test/workspace-inspection.test.mjs \
  tests/scripts/ailoha-installed-workspace.test.mjs \
  tests/scripts/ailoha-installed-host.test.mjs
node scripts/test-prepared-ailoha.mjs
node --test tests/scripts/*.test.mjs tests/web/*.test.mjs vscode/test/*.test.mjs
```

`tests/scripts/fixtures/workspace-projects.mjs` contains original synthetic
MAUI, Expo, React Native, Android and multi-target Xcode descriptors. The two
retained `workspace-inspection-{complete,incomplete}.json` fixtures were
serialized by the approved local own-source W3 scanner, whose SHA-256 was
`b98335c07b159507689c556502d68b1e0e8782fd74c729e0caff1c5ac7fe7793`.
Only `workspace.root` was normalized for checked-in tests; app/evidence/native
IDs and populated observations were retained. The scanner binary is **not**
installed, vendored, an SDK pin, or public/exact-CI/native-release proof.

The actual prepared GitHub registration and compiled VS Code
`runtime.ts`/`HostBridge`/workspace-folder adapter run against clearly marked
original consumer SDK/CLI doubles. They prove the canonical argument shape,
offline read-only behavior, no context/host creation solely for a scan,
unchanged target/context revision, missing SDK, trust/remote/root refusal,
diagnostics, cancellation and cleanup. Prepared test products with synthetic
pins are isolated copies, never public package artifacts.

The full prepared `device-canvas.js` is exercised with the existing
device-free Playwright server:

```sh
node tests/web/ailoha-device-browser-server.mjs \
  .build/copilot-plugin-thin/mobile-canvas <session-artifacts>/github-context.json \
  --workspace-inspection
node tests/web/ailoha-device-browser-server.mjs \
  vscode/dist <session-artifacts>/vscode-context.json --workspace-inspection
```

For each host separately, set `window.ailohaBrowserTestOptions` on a blank
Playwright page to the server's `{ url, evidenceUrl, fixtureRoot, secondRoot }`,
then run `tests/web/ailoha-workspace-browser-check.mjs`. The server controls
only its original synthetic fixture root/mode; the tests exercise complete,
incomplete, empty, unknown-schema, XSS text, root change, cancellation and
hide/resume. Browser checks of the VS Code prepared **shared renderer** are
separate from, and do not replace, compiled bridge/root tests.

For the existing real-WebCodecs geometry/media check, explicitly bind the
fixture's first root through its test-only control endpoint, set
`workspaceCards: true` in `ailohaBrowserTestOptions`, and run
`tests/web/ailoha-device-browser-check.mjs` on a fresh server. It checks cards
alongside four resizes and idle: exactly one initial video POST / zero DELETE,
96x64 encoded versus 48x32 logical geometry, tap (24,16) and drag (12,16) to
(36,16) at revision 14, then owned hide/resume cleanup. No legacy 400 ms
autoscale/session recreation is revived.

## Public installation gate

`lib/ailoha/runtime-package.json` now pins the actual anonymously published
`@ailoha/cli@0.2.5-preview.4` root tarball, integrity and source
`e31559ba06a3d926fa5903db3227e36ce519c8c9`, publication run `41132135307`
attempt `1`. Both host locks and prepared byte-graph receipts must agree.
No private/fixture pin, PATH CLI or sibling checkout substitutes for that
official graph. Metadata/import/package checks do not acquire or start its
native payloads. Normal installed-host routing and genuinely refreshed Mobile
Canvas native release artifacts remain separate qualification gates.

Both preparers refresh real shared web bytes; existing native binaries embed
older web assets and are not claimed to contain these cards. A later release
requires genuinely rebuilt native inputs, not stamped old binaries. This
follow-up stops at a narrow draft source PR with retained fixture evidence;
it does not publish packages/tags, merge either source PR or request a new
native platform matrix.

The existing legacy `.NET` host source also embeds/maps the newly imported
shared module so a future legitimate rebuild cannot break default renderer
loading. Its focused `DeviceApiTests` verify the asset and leave the workspace
API protected. The repository's full CI native source-hash gate may remain
red until genuinely rebuilt runtimes are supplied; that release limitation
must not be hidden by stamping the old runtime manifest.
