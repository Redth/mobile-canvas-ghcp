# Ailoha protocol consumer

`lib/ailoha/index.mjs` is an original Mobile Canvas-owned, host-side consumer of
the Target Host v1 interface. It is opt-in: both product hosts still use the
existing Mobile Canvas runtime by default. This is not a production cutover,
runtime acquisition mechanism, or declaration of an available Ailoha package.

## Explicit connection

```js
import { connectTargetHost, TARGET_HOST_PROFILE } from "./lib/ailoha/index.mjs";

const client = await connectTargetHost({
  origin, // http://127.0.0.1:<port> or http://[::1]:<port>
  hostId,
  profile: TARGET_HOST_PROFILE,
  controlCredential, // supplied privately by a trusted host-side connection owner
}, { timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024, signal });

try {
  const targets = await client.listTargets({ signal });
  const target = await client.getTarget(selectedTargetId, { signal });
  const capabilities = await client.getTargetCapabilities(target.targetId, { signal });
  const surfaces = await client.listTargetSurfaces(target.targetId, { signal });
} finally {
  client.dispose();
}
```

Connection requires an explicit profile, opaque host ID, canonical literal
loopback HTTP origin with a port in 1..65535, and a nonempty, printable ASCII
credential of at most 4096 bytes. DNS names, alternate numeric address spellings,
URL credentials, paths, queries, fragments, and HTTPS are rejected. An
authenticated status read must match the supplied host ID and profile before
`connectTargetHost` returns a client.
The host ID is the runtime's `serviceId` (also used in registration and private
metadata); comparison is exact and case-sensitive, not by name, PID, or device ID.

There is deliberately no broker/private-metadata discovery, environment
selection, process launch, or legacy fallback. A future trusted connection owner
must resolve missing/multiple hosts explicitly, match registration
ID/port/profile to private metadata, and verify filesystem ownership/permissions
and process identity. PID liveness alone is insufficient; Windows must not
silently bypass identity checks. Renderer input, workspace settings, and broker
projections are not trusted connection sources.

## Public API and wire behavior

The public API is `connectTargetHost`, `TARGET_HOST_PROFILE`, and
`AilohaProtocolError`; adjacent `index.d.mts` supplies TypeScript declarations.
Clients expose `getHostStatus`, `listProviders`, `listTargets`,
`getTarget`, `getTargetCapabilities`, `listTargetSurfaces`, `createTarget`,
`startTarget`, `stopTarget`, `rebootTarget`, `resetTarget`, `deleteTarget`,
`listOperations`, `getOperation`, `cancelOperation`, `waitForOperation`, and `dispose`.
`listTargets` accepts only optional `providerId`, `status`, and `signal`;
other reads accept only `signal`. No arbitrary API paths or caller headers exist.

All reads use `/api/v1` and bearer authentication, including status and inventory.
Collections are bare arrays. Status includes `profile`, `hostId`, `version`,
`state`, and `capabilities`; providers include `providerId`, `name`, `version`,
`state`, and `capabilities`. Targets retain `targetId`, `providerId`,
`targetTypeId`, `status`, and `surfaces`, plus documented optional metadata and
native identity. Provider ID is provenance, never a target route prefix.
Opaque IDs are encoded once per path segment without filename restrictions.
Empty IDs, `.`/`..`, invalid Unicode, and the contract's line-terminator
exclusions are rejected, as are inputs that would put the credential in a URL.

Surface bounds require `x`, `y`, `width`, and `height`; `coordinate` may be
omitted (the protocol default is `window`). Geometry revisions are unsigned
32-bit integers. Target capability feature names are operation IDs, whereas
surface features such as `tap.point` and `snapshot` are a distinct vocabulary.
Neither is synthesized or inferred. Unavailable providers remain in inventory;
empty arrays are accepted only as valid successful responses.

The HTTP transport never follows redirects or consults proxy environment
settings. It pins the request authority and Origin to the supplied literal
loopback endpoint. Response headers are capped at 16 KiB; bodies at 2 MiB by
default (configurable up to 8 MiB); total request time, including streaming, at
15 seconds by default (configurable up to 60 seconds). At most eight requests
or operation waits are admitted per client. A wait retains its slot between
polls and never issues parallel polls. Extensible response data is limited to 64 nesting levels.
Cancellation and disposal destroy pending requests;
disposal never stops the external host or its targets. Compressed responses are
rejected rather than risking unbounded decompression.

Unexpected success statuses, malformed JSON/UTF-8, invalid resource shapes, mismatched
identities, non-JSON errors, and transport failures remain explicit failures.
`AilohaProtocolError` has a stable `code`, optional HTTP `status`, and sanitized
`problem` for valid `application/problem+json` errors. Problem Details preserve
status, detail, context, and unknown extensions while redacting credentials and
credential-bearing fields. Raw transport exceptions, headers, and response
bodies are never attached as causes or included in messages. Successful resource
responses containing protected connection data are rejected, not rewritten.
Serializing or inspecting a client never exposes its private credential.

## Target lifecycle and operations

Mutation methods **submit work**, returning a validated `Operation`, not a
success flag or completed target. Create, lifecycle, target deletion, and
operation cancellation require HTTP `202` with an operation JSON body.
Reads still require `200`. The accepted `Location` must identify the same
opaque operation ID under `/api/v1/operations/`, relative to or on the selected
origin. It is validated, never followed; raw backslashes, queries, and fragments
are rejected. Both ordinary and fully escaped path
segments are supported without decoding an ID into a native device selector.
The host supplies `Retry-After: 1`; the explicit wait defaults to one-second polls.

`createTarget(request, { signal }?)` posts to `/api/v1/targets`. The request
requires `providerId` and `targetTypeId`; optional fields are `runtimeId`,
`templateId`, `name`, string-valued `labels`, JSON-object `configuration`, and
boolean `start`. The client snapshots these fields without synthesizing defaults.
**Omitting `start` preserves the existing server default of `true`; explicit
`false` requests stopped creation.** No separate start action is issued.
Create is itself explicitly requested and its operation is destructive; it does
not use the reset/delete confirmation gate.

`startTarget`, `stopTarget`, and `rebootTarget` post to
`/api/v1/targets/{encoded targetId}/actions/{action}`. Their options accept only
`signal` and optional `request`, whose wire fields are `reason`, JSON-object
`options`, and opaque `requestId`. An omitted request sends no body; `{}` remains
an explicitly empty body. `resetTarget` has the same shape plus mandatory
`confirmed: true`. `deleteTarget(targetId, { confirmed: true, signal? })` uses
`DELETE /api/v1/targets/{encoded targetId}` without a body.

Reset and deletion require an own data property with value exactly `true`;
missing, inherited, accessor, false, or non-boolean confirmation is rejected
**before any network IO**. `confirmed` is a consumer-side gate and is never sent
to the server. It does not claim user consent has been obtained: the eventual
product adapter must obtain and scope the real confirmation before setting it.
No UI/MCP adapter or public compatibility tool is changed by this slice.

Mutation bodies are strict JSON snapshots, capped at 64 KiB of serialized UTF-8
and 64 nesting levels. Unknown request fields, non-JSON values, accessors,
malformed identifiers, and protected connection data are rejected before IO.
There are no arbitrary paths, caller headers, mutation retries, or legacy
fallbacks, including after an uncertain transport outcome.

`listOperations({ targetId?, status?, signal? })` reads a bare operation array;
`getOperation(operationId, { signal }?)` reads one matching operation.
`cancelOperation(operationId, { signal }?)` uses `DELETE` without a body and
returns the current accepted operation. `cancelRequested: true` acknowledges a
request only. `queued`, `running`, and `cancelling` are nonterminal; only the
provider's eventual `succeeded`, `failed`, or `cancelled` is authoritative.
Cancellation may lose a race to normal success or failure. Failed cancellation
delivery leaves the operation pollable, with `cancellationProblem`; secondary
creation cleanup uses `cleanupProblem`. Neither replaces `status` or the
primary `problem`.

```js
const submitted = await client.createTarget({
  providerId,
  targetTypeId,
  start: false,
}, { signal });
const completed = await client.waitForOperation(submitted.operationId, {
  signal, timeoutMs: 30_000, pollIntervalMs: 1000,
});
// Only this helper's resolved result has status "succeeded".
```

`waitForOperation` is explicit and read-only. It resolves a `SucceededOperation`
only at `succeeded`, rejects `failed` as `operation_failed`, and rejects terminal
`cancelled` as `operation_cancelled`. Its total budget includes HTTP polling and
idle delays: by default the client's request timeout, configurable from 1 to
60,000 ms; each poll also honors the client's shorter request timeout. Poll
intervals are bounded from 1 to 60,000 ms. Timeout, caller abort, and disposal
stop local reads/timers only; they never cancel the external operation.
The explicit/default polling interval remains the wait policy. A subsequent
poll is scheduled only when its full interval leaves time before the absolute
deadline; otherwise the existing deadline timer ends the wait. Intervals are not
shortened into deadline-boundary reads, and server `Retry-After` hints cannot
override or extend the caller's total deadline.

Operation errors retain `operationId`, the latest validated `operation` when
available, and sanitized primary Problem Details. HTTP errors remain `http_error`
(including explicit `501` unsupported-capability evidence); cancellation and
cleanup problems remain separate in the operation DTO. An observed, validated
accepted `Location` retains the recovery ID even if the body later times out or
truncates, without claiming completion or replaying the mutation. A mismatched body cannot
replace that recovery ID; a caller-selected operation ID takes precedence over
both response sources. Operation results and
identities containing protected connection data are rejected; nested Problem
Details are validated and redacted without discarding context or extensions.
Optional operation fields remain absent when omitted, including `cancelRequested`.
Operation kinds remain nonempty extensible strings for read/list.

## Both product hosts

The GitHub canvas can import the module directly from `lib/ailoha/index.mjs`.
The VS Code extension host can dynamically import
`context.asAbsolutePath("dist/lib/ailoha/index.mjs")` using `pathToFileURL`, as
its existing runtime adapter does. Both packaging scripts include the same
module; it must not be imported by `web/` or a VS Code webview. Only validated
resource DTOs and sanitized errors may cross a renderer boundary.

Both packages also stage the original browser-safe
`web/ailoha-video-protocol.js` ALHV/1 parser. Prepared-asset tests import each
host's actual client and parser copies, compare them byte-for-byte with shared
source, and exercise authenticated fake-loopback reads, lifecycle submissions,
confirmation gates, operation cancellation/terminal waits, sanitized errors, and
zero-copy frame parsing. Package verifiers require these files. The VS Code
unit-test command prepares the GitHub thin plugin with the existing packaging
script; its script checks also validate `index.d.mts` and the declaration usage
fixture with TypeScript.

## Installed opt-in vertical slice

`MOBILE_CANVAS_BACKEND=ailoha` selects the GitHub canvas/MCP opt-in. VS Code also
exposes the application setting `mobileCanvas.backend` with default `legacy`;
reload the window after changing it. Both installed paths use
`lib/ailoha/runtime-backend.mjs`, the original compatibility projection/client,
and the shared `web/ailoha-video-player.js`. Legacy remains the default; an
Ailoha refusal, timeout or operational failure never invokes the legacy engine.

**Package readiness is gated.** No public runtime version, integrity or source
pin is guessed. `lib/ailoha/runtime-package.json` is required before the official
small launcher graph is staged. Until the owner supplies verified anonymous
artifacts, the opt-in reports `ailoha_runtime_unavailable`. Normal installs must
not require a private source checkout, another worktree, PATH-installed CLI,
install hooks or end-user `npm install`.
Malformed provenance reports `ailoha_runtime_pin_invalid`; a read failure reports
`ailoha_runtime_pin_unreadable`. Neither is silently classified as a missing SDK
or allowed to start the legacy engine.

The approved SDK entry is `@ailoha/cli/runtime`. Acquisition calls
`getRuntimePin`, `ensureTargetHost`, and `openTargetHostTransport`. The official
SDK owns selected-RID lazy native acquisition, private metadata/process checks,
direct bounded authenticated HTTP/WS and lease cleanup. Mobile Canvas adds no
native downloader, private credential reader or bearer-bearing renderer URL.
Only the approved small launcher/dependency graph is copied by the host
preparers, with tarball/integrity and license notices retained. Its dependencies
must be bundled within the pinned launcher; hoisted checkout dependencies cannot
substitute for an incomplete installed graph. The complete bundled tree,
including transitive dependencies, is retained without native optional packages
or symlinks. Both archive verifiers compare the complete staged tree with its
deterministic byte fingerprint and require matching package/runtime source pins,
dependency versions and notices. A receipt checks staged-byte consistency; it
does not establish anonymous publication of the upstream tarball. VSIX validation
permits upstream source maps only inside that verified pinned graph, preserving
the publisher's bundled bytes; Mobile Canvas source, tests and generated maps
remain excluded. Required native RIDs and public pins remain upstream release
evidence, not consumer assumptions.

`connectTargetHostTransport` applies the same strict validators and bounded
operation waits to the factory's `response()` metadata without requiring or
projecting an origin/credential. Caller abort signals the owner immediately,
then permits typed response/error settlement within the original request budget;
it does not assume a one-event-loop-tick handoff or reset/extend the deadline.
Delivered, validated `Location` evidence remains recoverable when a body
truncates, times out or disagrees. If the owner withholds metadata past that
deadline, cancellation remains bounded and the outcome is explicitly unknown,
not a guarantee of universal abort-Location retention or grounds for replay.
JSON failures use failure HTTP statuses at the product boundary even when the
upstream malformed response was 201/202; accepted is never presented as completed.

### Selection, input and cleanup

Opaque host/target/surface IDs are separate from `nativeIdentity.nativeId` and
serial/provider provenance. Missing providers, multiple surfaces and unknown
native deployment identity are explicit. Target records expose `surfaces`;
opt-in `open`/`select_device` and `mobile_device_select` accept an additive
`surfaceId` to resolve a multiple-surface target. The existing 24 canvas and 61
MCP identifiers are unchanged.

The context adapter uses only the verified canonical CLI launch and
`context open/get/select/detach` with returned opaque `contextRef`, string
`scopeEpoch`/`revision`, and whole-tuple CAS. The owner PID is the product process,
not the Target Host. A unique live session/window ID plus its view ID defines
scope; workspace preference hashes are not view identity. Ordinary reads cannot
create/reopen authority, stale reads cannot overwrite a tombstone, and bound MCP
cannot revive a detached/closed view. Genuine view binding may reopen explicitly.
Ordinary hide/reload preserves selection/epoch; destructive scope retirement
does not silently restore a selection.

The static GitHub plugin MCP path fails closed without explicit `--context`,
`--context-epoch`, `--session`, `--instance` and `--owner-process`. It cannot
infer the first panel or derive private context filenames. VS Code supplies its
actual window/view binding and refreshes MCP definitions after a genuine context
open. Binding discovery itself cannot create or reopen an authority: before a
trusted view opens it reports `context_not_bound`, and a retired view reports
`context_retired`. The first slice is target-only; app/agent/runtime-instance
selectors are not adopted as native package identity.

### Internal host incarnation evidence

`targetHostId` is a persistent discovery identity, not a process incarnation.
The trusted backend captures the official lease's full `connectionRef`
(`serviceId`, `pid`, `startedAt`, `processStartedAt`, and `schema` when supplied)
as a frozen value before opening its transport. Trusted backend/canvas/VS Code
bridge adapters expose `connectionRef`; `captureInvocation` retains the same
frozen value in a non-enumerable host-only property after public capture.
`captureConnectionRef` and `sameConnectionRef` are the shared capture/comparison
helpers; no derived `hostInstanceId` or private metadata lookup is used.

Spreading, structured-cloning or publicly projecting an invocation deliberately
drops that internal property. Trusted adapters that extend an invocation must
retain its `connectionRef` separately with their private receipt/progress, not
recover it from renderer/MCP output. A changed tuple rejects same-key lifecycle
recovery or unknown video-create replay as `runtime_incarnation_changed`; it
does not discard the old receipt or attach cleanup to the replacement transport.
New unrelated explicit actions remain independent.

This evidence is not an atomic request-time process fence. The official SDK
validates owner/process/pin/metadata when a transport is opened; its HTTP socket
and credential remain captured afterward. Managed credential rotation can close
or reject that old transport, while reused external credentials leave a
request-time race. Mobile Canvas neither refreshes/replays mutations across
changed evidence nor claims that comparing a precheck eliminates that race.

`get_selected_device`/`mobile_device_get_selected` include a non-secret
`contextBinding` projection when backed by the canonical authority:
`contextRef`, `scopeEpoch`, string `revision` and the actual product
`ownerProcessId`. This is the explicit binding used for a separately configured
MCP process, not a ref hash or inferred first panel. An open empty view returns
`hasSelection: false` with its verified binding and scope, allowing read-only
inventory without inferring a target. A retired authority returns an explicit
error, not an empty usable binding; adapters without a canonical projection keep
the original `{ hasSelection: false }` output. Invocation results retain the same
captured `executionContext` separately from local selection generation.

The canonical adapter returns selection, context projection, identity and state
as one immutable read snapshot. Target/provider probes cannot borrow a later
read's revision or epoch. Known superseded snapshots reject undispatched work;
display observations retain the same captured identity. Already accepted
lifecycle receipts keep their original target and context metadata through later
reads or a trusted authority reopen, without resubmission or relabeling.
Direct target reads use the same snapshot guard without changing selection;
an external tombstone is checked before target-host reads, not inferred from a
previously cached open state.

Input captures one view/host/target/surface tuple and observed logical bounds,
coordinate space and geometry revision. Additive `surfaceId`, `coordinate` and
`geometryRevision` inputs preserve that observation. Encoded frame size is never
an input coordinate space. A queued/stale gesture is rejected, not retargeted.
HTTP gestures preserve requested seconds as bounded millisecond pauses and
intermediate pointer moves (maximum 30 seconds); held presses require the actual
`long-press.point` surface capability, not just `tap.point`.

Lifecycle submits an accepted operation and polls that captured ID to terminal
success. Lost accepted bodies and timed-out waits retain a bounded receipt across
view resource replacement; a subsequent action resumes the original operation
with GET/wait, never a repeated POST. An outcome without a recovery receipt is
explicitly uncertain and is not replayed. Reset/delete require both the own
literal confirmation gate and real scoped consent; the opt-in has no such human
consent adapter and reports them
unsupported. Create/start omission semantics in the underlying client remain
unchanged, but the existing creation/catalog compatibility workflow is not
enabled in this slice.

PNG capture validates its 201 artifact/Location, ownership, MIME and applicable
size/digest before reading content. Video session creation preserves omitted
encoder settings; the renderer receives only owned session/geometry/source
projection and ALHV units. Host callbacks buffer bounded early messages before
that descriptor. Created sessions register captured cleanup: socket close,
session DELETE, then authoritative operation wait before lease release. A lost
202 cleanup body retains validated operation Location and retries only GET/wait,
never DELETE or a broad 404-as-success fallback. Unknown create outcomes cannot
automatically create a replacement on close/reopen.

Hide/close/dispose retires only that view's sockets, receiver, decoder and owned
resources. The shared host/broker/devices remain running. Provider state and
description are projected separately from a connected control plane; unavailable
tooling is not a ready-shaped empty inventory.

### Scope and verification

Implemented: inventory/select, advertised start/stop/reboot, PNG screenshot,
basic geometry-bound pointer gestures and shared ALHV WebCodecs display.
Unsupported: compatibility creation/catalog, reveal/rotation/keyboard/buttons,
reset/delete without scoped consent, app/system semantic trees, app deployment,
recording and broader settings/diagnostics/file/hardware operations. No claim of
device or full feature parity is made.

Tests exercise actual prepared GitHub entrypoints and compiled VS Code bridge
imports with narrow official-shaped SDK/context doubles, not only repository
helpers. The prepared-module runner repeats ownership/geometry/close/reopen,
consent, provider readiness, lost201/202, unsupported/operational failures and
decoder tests against each copied host. Real Chrome WebCodecs decoded the
own-generated baseline/window-one and reordered High/two-B fixtures through both
prepared players; all I420 planes matched references. RGB conversion differences
in baseline PNG comparison are diagnostic, not a rendering-parity assertion.
Fixtures are test-only; FFmpeg is not a product dependency.

The full prepared `device-canvas.js` browser check also resizes the actual
painted canvas and performs real mouse tap/drag input. It asserts exactly one
video POST and no DELETE during startup, four resizes and idle; logical
coordinates/revision, hidden unsupported controls, and owned hide/resume cleanup.
Legacy FPS/scale reconciliation is not run for Ailoha, including queued timers;
an unchanged scoped selection announcement does not recreate the live resource.
`tests/web/ailoha-device-browser-server.mjs` serves only the synthetic fixture;
`ailoha-device-browser-check.mjs` is a Playwright MCP code file to repeat that
check. On a blank page set `window.ailohaBrowserTestOptions` to the server's
`{url, evidenceUrl}`, then run the code file; it navigates once into a fresh
fixture host and verifies resource counts, pointer input and hide/resume.
Prepared VS Code shared renderer checks use the same host adapter; the separately
tested compiled extension/webview bridge is not replaced by a browser-only proxy
claim.

```sh
npm ci --ignore-scripts --omit=optional
npm ci --prefix vscode --ignore-scripts
node scripts/prepare-plugin.mjs --thin
node scripts/prepare-vscode.mjs --thin
npm run compile --prefix vscode
node --test tests/scripts/ailoha-installed-host.test.mjs
node scripts/test-prepared-ailoha.mjs
node tests/web/ailoha-player-browser-server.mjs
```

Native binaries embed `web/`, so native source fingerprints include those bytes,
not just `.csproj` changes. Existing published payloads are not re-stamped to
pretend they contain new assets. Build review-only payloads from the reviewed
head and package them in an isolated directory:

```sh
./scripts/build.sh osx-arm64
./scripts/build.sh osx-x64
MOBILE_CANVAS_RELEASE_TAG=unpublished-review \
  node scripts/bundle.mjs --rid osx-arm64 --from .build/bin/osx-arm64 --out .build/review/runtimes
MOBILE_CANVAS_RELEASE_TAG=unpublished-review \
  node scripts/bundle.mjs --rid osx-x64 --from .build/bin/osx-x64 --out .build/review/runtimes
node scripts/prepare-plugin.mjs --runtime-dir .build/review/runtimes
node scripts/prepare-vscode.mjs --runtime-dir .build/review/runtimes
```

These are pack-only artifacts, not published tags or normal-install manifests.
Other native platforms, verified public SDK graph/pins, legal provenance and
device parity remain release gates. No Ailoha implementation, UI, skill or schema
source is vendored.

The interface reference is the Target Host contract at
`microsoft/ailoha@2175ed5c5a19dcd8a23148023978f9f7b811d6fb`, specifically
`docs/target-host/README.md`, `docs/target-host/openapi.yaml`, and the referenced
resource definitions. These references were readable only with authorized
repository access; anonymous public availability has not been established.

Focused checks use only Node and fake loopback HTTP servers:

```sh
node scripts/prepare-plugin.mjs --thin
node scripts/prepare-vscode.mjs --thin
node --test tests/scripts/ailoha-client.test.mjs tests/web/ailoha-video-protocol.test.mjs vscode/test/prepared-assets.test.mjs
vscode/node_modules/.bin/tsc --noEmit --strict --target ES2022 --module Node16 --moduleResolution Node16 lib/ailoha/index.d.mts tests/scripts/ailoha-client-types.mts
```
