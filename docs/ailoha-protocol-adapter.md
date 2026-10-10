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
`listProviderCatalogs`, `listProviderRuntimes`, `listProviderTargetTypes`,
`listProviderTemplates`, `getProviderDiagnostics`,
`getTarget`, `getTargetCapabilities`, `listTargetSurfaces`, `createTarget`,
`startTarget`, `stopTarget`, `rebootTarget`, `resetTarget`, `deleteTarget`,
`listOperations`, `getOperation`, `cancelOperation`, `waitForOperation`, and `dispose`.
The source-only target-app client also exposes `listTargetApps`, `getTargetApp`,
`launchTargetApp`, `terminateTargetApp`, `uninstallTargetApp`, `listTargetAppOps`,
and `updateTargetAppOp`. These use the published `/api/v1/targets/{targetId}`
app and app-op routes, not workspace application or agent identities.
Mutations return accepted operations; launch/terminate/uninstall do not treat
HTTP 202 as completion. Uninstall's `confirmed: true` is only a client-side gate,
not evidence of human consent. App-op PUT returns a descriptor rather than an
operation. Native package IDs are resolved through canonical app inventory,
not assumed to equal `appId`.
The reviewed 599 owner SDK **source** transport allows GET, POST, PATCH and
DELETE, not PUT; this source is not yet a pinned public package. Although the
canonical app-op endpoint is PUT, the owner transport cannot currently forward
it. App-op mutation remains gated pending a compatible reviewed SDK contract.
`listTargets` accepts only optional `providerId`, `status`, and `signal`;
other reads accept only `signal`. No arbitrary API paths or caller headers exist.

The Mobile Canvas opt-in routes seven existing app tool identities to the shared
backend used by the GitHub canvas and VS Code HostBridge/MCP proxy. For now,
canonical launch and terminate require positive per-target capability evidence,
native package lookup, target/provider/native identity rechecks before submission,
exact operation ownership and terminal success.
Cold relaunch retains confirmed termination independently of its non-running
app read: failed readback retries only that read, never the successful stop,
and launch remains fenced to the original context. Legacy API launch arguments are forwarded to the canonical
request; distinct argument lists cannot borrow one another's accepted receipts.
The original target and accepted receipt survive UI selection
changes; an unknown acceptance is never retried or routed to legacy.
The Target Host ID is stable discovery identity across process restarts, not an
incarnation fence. The reviewed source lease's full connection reference fences
same-key app receipts and cold-relaunch recovery across process replacement,
including confirmed stops. The original named revision separately fences every
relaunch continuation even after reselecting its target. This is private host
evidence, not renderer or MCP output. The reviewed source owner transport does
not atomically verify process identity with each HTTP mutation;
safe same-credential external restart mutation still needs a request-time
native fence.

This source-only slice **does not yet claim full app parity**. The reviewed
native source contract adds optional `InstalledApp.kind`, process ID, path and
data container; the shared adapter returns nonempty inventory only when each
app reports user/system kind and a stable running state. Nullable fields with
no native evidence remain null, never invented, and `includeSystem` is passed
to the backend and sorted as in the legacy service. Empty supported inventory
is returned as empty, not inferred from a failed read. Optional `AppOp.uidScoped`
allows Android app-op results only when every operation reports effective UID
scope and a legacy-compatible mode; otherwise the result is explicitly
unsupported. App-op mutation still requires scoped consent and readback.
The reviewed native adapter optionally preserves launch result process ID and
detail in the completed operation, which are returned when present and valid;
unknown optional values remain null rather than invented.
The source-conditional install adapter uses the reviewed **source** contract at
`microsoft/ailoha` `c8caabd589d8c008adac33107846bc322632977a`:
verified host CLI `target app stage` streams a readable local `.apk`, `.ipa`
or `.zip` file or archives a `.app` directory, then `install-staged` submits
an accepted operation against its exact captured ref/epoch/revision and
`stage-cleanup` requests deletion of the original owned artifact. The native
artifact stream is capped at 512 MiB and its upload deadline is ten minutes;
the verified CLI stage process has an eleven-minute ceiling for local bundle
archiving plus that bounded upload; the verified install and cleanup controls
retain a 30-second ceiling. The stage deadline is bounded per command; the
original scoped approval signal and remaining monotonic budget also bound the
install submission attempt after consumption, including verified CLI launch
acquisition, without restarting that budget. Owned cleanup has its own
original-resource lifetime. Approval must actually resolve before revalidation
and consumption, never merely be requested. A definitive pre-dispatch expiry
cleans the known staged artifact; an uncertain install submission retains its
original receipt without retry or speculative cleanup. The native host checks
the expected process incarnation and stamped provider/target identity before
accepting the staged install. Mobile Canvas retains the
full private stage proof and original lease `connectionRef`, waits for terminal
install and artifact-delete operations, and never uploads package bytes or
the receipt through a renderer. Unknown submission outcomes are not retried.
The legacy install result can only report a native bundle/package ID when
canonical evidence identifies it; the conditional adapter returns null rather
than inventing one and does not expose the host source path as `detail`.
**This source approval is not a public runtime pin or production activation.**
Both installed hosts still report install unsupported without a compatible
verified public CLI, coordinator-approved package/command provenance, advertised
target/host capability and genuine scoped host approval. The reviewed c8
feature-source hash is not an eventual merged public SDK pin and does not
auto-enable the staged adapter. Both hosts now have inherited scoped human
approval for reset/delete; the source-only install flow reuses that authority,
but no boolean `confirm` argument alone enables staging or installation. The
existing combined install CLI/MCP commands lack this original-view fence;
neither renderer buffering nor a direct native process fallback is used.
Uninstall additionally requires real scoped host consent; `confirm=true` by
itself never authorizes it. App-specific uninstall approval and readback are not
implemented even where reset/delete prompts are available. All these
limitations fail explicitly without fallback.

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
Lifecycle/reset/delete consumer options accept an optional integer `timeoutMs`
that can only lower the configured client request ceiling. It bounds original
admission and body work through the existing owner transport and is not a REST
body field or a new official SDK signature.

Reset and deletion require an own data property with value exactly `true`;
missing, inherited, accessor, false, or non-boolean confirmation is rejected
**before any network IO**. `confirmed` is a consumer-side gate and is never sent
to the server. It is not evidence of human consent: the product adapters obtain
the separately captured approval described below before setting it.
Creation is explicitly requested through the existing non-erasing workflow.

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

### Catalog choices and creation

`mobile-catalog.mjs` reads only genuine advertised `provider.catalog` operations
at `/api/v1/providers/{providerId}/{catalogs|runtimes|target-types|templates}`.
Every descriptor is schema-checked and matched to the captured provider/host.
Raw descriptors, template configuration and dependency guidance remain in
`providerCatalogs`. Missing advertised responses are failures, not empty arrays;
missing capabilities produce explicit inventory-only/partial catalogs.
Native settings guidance is retained but does not enable unwired settings controls.

The legacy `runtimes`/`deviceTypes` fields use reversible, versioned
`ailoha-catalog-v1:` IDs containing the exact host/provider/catalog tuple.
They never interpret an Ailoha opaque ID as a UDID, AVD or provider prefix.
`catalogSelection`, `canonicalRuntimeId`, `targetTypeId` and `templateId` expose
the canonical identities separately. Native runtime metadata's explicit
`supportedDeviceTypeIds` preserves the established compatibility semantics:
an empty advertised list permits matching-platform types; absence is not an
unconstrained list. Providers without that metadata need exact template pairs.
Unknown references, duplicates, cross-platform pairs and configuration-dependent
choices are rejected or positively unsupported. Only available choices with
host/provider/type create+boot evidence enable the existing dialog.

`create_device`, the panel API and `mobile_device_create` use one canonical
`POST /api/v1/targets` with `start: true`, preserving public Mobile Canvas
create-plus-boot semantics without a second start POST. Platform still defaults
to `ios`; Android requires its explicit platform and returned choices. Raw MCP
creation does not select, matching the unscoped legacy tool; canvas/panel and
the VS Code MCP adapter follow the captured view only if its original selection,
epoch and revision remain current. A late result returns the created native
record with `selectionApplied: false`, never retargeting the changed view.
Reopening the same live authority under a replacement resource compares the
original canonical identity, not a restarted owner's local generation counter.

Creation and lifecycle share `operation-receipts.mjs`. Same-key catalog validation
and confirmation are single-flight, with bounded preparation and shared 64-receipt
pools and post-await scope/admission checks. Valid accepted Location survives a lost body;
timeout, hide/resource replacement, reopened authority and output-confirmation
failure retain the original receipt. Retry uses GET/poll, not create/start.
Terminal creation failure/cancellation and unknown acceptance remain retained;
cancellation is not rollback. Success requires a correlated terminal operation,
the exact created type/runtime/template/name, running state and authoritative
virtual-device native identity. Errors retain operation metadata and any
attributable `createdTargetId`; no client-side destructive cleanup is attempted.

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

Creation captures that same frozen connection evidence in its non-enumerable
private invocation before submission. Every same-key retry checks it before
catalog/context/operation/target reads, including unknown acceptance, pending
operations and succeeded operations awaiting output confirmation. A replacement
service ID, PID, service start or process start cannot join an old owner's
confirmation promise or resume its receipt. Receipt keys use the original
compatibility choice tuple, not the replacement owner's discovery/incarnation
identity, so that mismatch never authorizes new catalog reads or another create
or boot.
Original-owner accepted work and cleanup keep their original captured transport;
public creation results and error envelopes deliberately omit this private tuple.

Spreading, structured-cloning or publicly projecting an invocation deliberately
drops that internal property. Trusted adapters that extend an invocation must
retain its `connectionRef` separately with their private receipt/progress, not
recover it from renderer/MCP output. A changed tuple rejects same-key lifecycle
and app-receipt recovery, cold relaunch continuation, or unknown video-create
replay as `runtime_incarnation_changed`; it does not discard the old receipt or
attach cleanup to the replacement transport.
New unrelated explicit actions remain independent.

This evidence is not an atomic request-time process fence. The official SDK
validates owner/process/pin/metadata when a transport is opened; its HTTP socket
and credential remain captured afterward. Managed credential rotation can close
or reject that old transport, while reused external credentials leave a
request-time race. Mobile Canvas neither refreshes/replays mutations across
changed evidence nor claims that comparing a precheck eliminates that race.

### Captured human approval

`confirm: true` remains the compatibility intent flag, not proof that a person
approved. The GitHub canvas uses the joined SDK session's advertised
`capabilities.ui.elicitation`, `session.ui.elicitation`, and the matching
`elicitation.requested` event. Cancellation uses that event's request ID through
`session.rpc.ui.handlePendingElicitation`; no permission hook auto-approves.
VS Code uses a native `createQuickPick` with an explicit "Approve once" choice
and a non-destructive default. Accept/hide callbacks and abort dispose that
picker. Renderer JSON never supplies an approval. Legacy confirmation UX is
unchanged; Ailoha skips the renderer-only confirmation and requests its trusted
host prompt instead.

The private shared authority captures the original action, invocation object,
canonical ref/epoch/revision, provider/native target, and frozen full
`connectionRef`. One monotonic 60-second budget covers prompt, revalidation and
the submission attempt,
not a fresh timeout after approval. Selection change, observed authority
retirement/replacement, owner disposal, caller cancellation, or expiry retires
the approval; a late result cannot revive it. The pending prompt pool is bounded
to 128 independently of the unchanged 64 accepted-operation receipts.
Immediately before a new reset/delete submission, the backend rereads the
canonical context and target/provenance/capabilities, compares the captured
snapshot and native identity, checks admission again, and spends approval in
the same synchronous turn as receipt insertion and submission. It does not
serialize unrelated operations. Accepted or uncertain work retains its original
receipt and is not replayed or rebound to a replacement incarnation.

MCP requires the client's supported form-elicitation capability and sends a
nested `elicitation/create` request. The stdio parser correlates those responses
outside the serialized tool queue, preventing an approval deadlock.
`notifications/cancelled`, EOF, and owned shutdown retire pending prompts.
Unsolicited/late replies are ignored with diagnostics; clients without form
elicitation receive explicit `consent_not_supported`, not automatic approval.

Trusted app adapters reuse `backend.supportsDestructiveApproval` and
`backend.beginDestructiveApproval(action, originalInvocation, options)`.
The returned private handle has `approved`, `signal`, `run(work)`,
`requireCurrent()`, `remainingTimeoutMs(ceiling)`,
`consume(originalInvocation, currentStagedArtifact?)`, `submitted()`, and
`dispose()`. `run` waits for genuine approval before starting revalidation.
One original monotonic 60-second deadline spans question, revalidation and the
submission attempt; consuming the approval does not clear or reset that budget.
The submission signal retains caller/backend lifetime cancellation; for app
installation the original API/MCP caller signal also bounds staging and approval,
while artifact cleanup uses a separate owned backend-lifetime budget.
`remainingTimeoutMs` gives the smaller of the original remaining whole
milliseconds and the existing CLI/client ceiling (30/15 seconds respectively).
The submission adapter signals `submitted()` only after capturing its actual
acceptance, typed failure, or unknown result; `run` does so when its consumed
attempt settles. Neither expiry nor cancellation rolls back or replays accepted
work. Cooperative metadata may settle within the remaining original budget;
if the attempt has not settled at expiry, its outward outcome is explicitly
unknown and its original receipt remains owned. No universal late Location
recovery beyond that boundary is claimed.
Finalization rechecks the monotonic deadline itself, not only its timer.
Late results remain in the private `submissionResult`/original operation
receipt, while the originating caller receives an explicit unknown outcome.
HTTP 408/499 and disposed-client uncertainty are not definitive submission
rejections: they cannot evict an uncertain lifecycle, app, creation, or video
receipt and cause another mutation. Definitive local pre-admission denials and
HTTP 403 still release their exact receipts. A retained authoritative operation
ID can still be recovered by GET without a new approval or POST.
The canonical adapter also captures a frozen, non-enumerable `contextOwner`
(`processId`, exact `processStartedAt`) in the same snapshot and invocation.
Install proof PID and owner birth must match this original value exactly;
missing owner evidence fails closed. Public cloning drops it deliberately,
without inventing a public context field or normalizing precision through
JavaScript `Date`.

For the separately owned install workflow, `options.stagedArtifact` is the exact
canonical staged record: artifact ID, literal source path, receipt, size,
SHA-256, and its whole native receipt proof. A private immutable copy is bound
to the approval, including source-path/receipt hashes and literal native
`proof.hostInstanceId`; this existing native field is not derived into a
consumer incarnation alias. Only package name/digest/size and captured
target/view details are presented to the human. Source path, receipt, full
proof, and process evidence never cross renderer/MCP boundaries. Install
adapters must retain the original invocation before public cloning, revalidate
their native stage/target/context, and pass the unchanged complete staged record
to `consume` immediately before submission. This host seam does not implement
or claim public/native installation readiness.

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
literal confirmation gate and real scoped consent. Hosts without the required
approval facility report these actions as unsupported. Create/start omission
semantics in the underlying client remain unchanged; the compatibility creation
path explicitly requests `start: true`.

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

Implemented: authoritative advertised catalogs and compatible create+boot,
inventory/select, advertised start/stop/reboot, PNG screenshot,
basic geometry-bound pointer gestures, shared ALHV WebCodecs display, and
[read-only explicit-root workspace/application evidence](ailoha-workspace-inspection.md),
plus read-only canonical composed `app_tree`, `app_query` and `app_status`
through the host-owned MCP client. System reads require the selected Target
Host target and request `target-host` routing; App reads require an explicitly
selected `verified-native-instance` in the named context and request
`require-agent` routing. Each result checks captured context ref/epoch/revision,
target, surface, owner and native runtime provenance before display; retired
reads never project. The shared UI bounds depth, element count and text, and
renders canonical element text literally. Changing a lens or operation retires
the previous read without clearing typed query filters. Canonical MCP errors
expose only a finite public capability code/message or a fixed failure message;
native stderr, paths and error details are not forwarded to the renderer.
The official JS MCP SDK's full tool-list validator rejects native C# tool
metadata such as a valid boolean JSON Schema `true` at
`outputSchema.properties.result` (for example `target_file_mkdir`);
discovery validates only bounded advertised tool names
through that SDK, then validates the actual composed result against captured
route and provenance. The stdio child receives only named context/broker
configuration from the host environment, never ambient target/agent selectors.
The legacy .NET canvas serves the shared semantic module as a public embedded
bootstrap asset, while its inspection API remains authenticated. This
source-only slice has no
workspace-application-to-native-agent mapping, binding control, or legacy
`ui_*` compatibility claim. Both hosts bundle the exact-pinned MCP client
graph, while the official Ailoha runtime pin remains a separate release gate.
Controlled native development CLI proof exercised System and explicitly bound
App tree/query/status through both prepared host clients against the real
canonical broker and mock Target Host/Core-MAUI agents, including stale-context
and missing-Agent failures. This does not qualify a public package, normal
installation, native platform matrix or real-device acceptance.
Unsupported: configuration-dependent creation, reveal/rotation/keyboard/buttons,
reset/delete without scoped consent, app deployment,
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

`mobile-ailoha-creation.test.mjs` asserts exact POST counts across canvas/API/MCP,
both-platform and template projections, ambiguous/partial/unavailable catalogs,
lost 202 bodies, unknown acceptance, timeout, failure/cancellation, stale views,
pool races and receipt reuse under replacement owners. The installed entrypoint
fixture also creates both platforms through the actual GitHub registration and
compiled VS Code bridge, and exercises the compatibility MCP dispatcher. Its
controlled app fixture checks native package-ID routing, reported inventory
metadata, accepted launch completion, terminate, Android app-op reads and
positive install/uninstall/app-op mutation and iOS app-op gates through both
installed hosts. It does not install or change a real app.
All provider mutations are original synthetic fixtures, not native-device acceptance.

`ailoha-creation-browser-server.mjs <prepared-root> <github|vscode> <context-file>`
serves the complete shared renderer with synthetic catalogs/creation. Its VS Code
mode uses the actual compiled HTML builder, theme/transport scripts and HostBridge;
only the browser's stand-in for native webview IPC uses a test-only HTTP/SSE shim.
Run `ailoha-creation-browser-check.mjs` in Playwright with
`window.ailohaBrowserTestOptions` set to the emitted options. It verifies enabled
compatible create controls, both-platform payload/native IDs, real WebCodecs
resize/idle behavior, one video per creation handoff despite its selection echo,
stale-selection protection and zero leases/videos after hide.
Stop the helper to restore/remove its explicitly synthetic prepared pin.

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
Catalog/create choices and actual start semantics were additionally checked at
`microsoft/ailoha@58761b338b9344a3b4d912c5c75233bfcf67ac20`: core/mobile/context
schemas, `TargetHostEndpoints`, `TargetModels`, `TargetCatalogTools`, advertised
capability folding and the mobile provider's runtime metadata/create dispatch.
This consumer does not vendor those provider/runtime/scanner implementations.

Focused checks use only Node and fake loopback HTTP servers:

```sh
node scripts/prepare-plugin.mjs --thin
node scripts/prepare-vscode.mjs --thin
node --test tests/scripts/ailoha-client.test.mjs tests/web/ailoha-video-protocol.test.mjs vscode/test/prepared-assets.test.mjs
vscode/node_modules/.bin/tsc --noEmit --strict --target ES2022 --module Node16 --moduleResolution Node16 lib/ailoha/index.d.mts tests/scripts/ailoha-client-types.mts
```
