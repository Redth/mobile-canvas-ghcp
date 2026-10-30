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
DELETE, not PUT; this source is not yet a pinned public package. The ordinary
app-op endpoint is PUT and ordinary uninstall DELETE cannot fence the captured
named context through final native dispatch. Neither route is used for the
source-conditional destructive app actions described below.
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
unsupported. Source-conditional uninstall and Android app-op mutation use
distinct positively advertised fenced capabilities plus the verified CLI.
The Mobile producer's Android package inventory reads optional numeric UID
alongside the APK path using the existing package manager; if UID listing is
unavailable, the ordinary inventory still works but UID stays null. Missing or
invalid UID cannot be inferred from the package name or APK path to fabricate
Android native installation evidence.
Before a host approval prompt, `target app action-capture` must return one
v2 private receipt matching the original named ref/epoch/revision,
literal process owner, host incarnation, provider/native target, installed
app ID/package/version/build, authoritative installation evidence, and a
unique lower-hex 32-character attempt ID. The exact receipt is limited to
64 KiB of UTF-8 bytes. Its native private single-use claim prevents a second
mutation from the same capture, including across consumer processes. Setter
capture also binds operation, current/requested mode and UID scope; unavailable
native installation or UID evidence is unsupported, not guessed. The prompt
shows the captured package, and for the setter the current-to-requested mode
and whole-UID effects. Approval expires within the original 60-second budget;
submission uses only `uninstall-fenced` or `set-app-op-fenced` with the captured
receipt. The accepted and completed uninstall Operation is destructive;
the accepted and completed setter Operation is not. It never uses ordinary
DELETE/PUT, trusts `confirm=true` as human
approval, or sends private evidence to a renderer. The original accepted
Operation ID remains available for GET-only recovery on uncertain delivery,
including late acceptance; neither mutation is replayed. Known accepted IDs
remain opaque and are never rewritten or truncated; unknown delivery without
an ID never acquires invented acceptance evidence. Android setter
success additionally requires terminal effective mode and UID-scope readback.
The local CLI contract emits exit-1 JSON on stderr without an HTTP status:
`AppActionRejected` and stale-context/binding types are definitive
non-admissions when no accepted ID is reported, whereas
`AppActionDeliveryUnknown`, `AppActionAttemptAlreadySubmitted` and
`AppActionAcceptedRecordUnavailable` without an ID retain an uncertain
same-key receipt without another submission. `AppActionAcceptedMismatch`
reports the typed failure with its opaque original operation ID on that call.
A later explicit same-key request can GET a known ID without another capture,
approval or submission; the terminal operation must still match the original
action, target and provider. Malformed IDs cannot create acceptance or permit replay.
After admission, receipt-owned confirmation is independent of each caller's
cancellation. A completed result stays on the original receipt until a live
caller returns it; only then can a new same-key action be submitted.
Its `retryable:false` field is not
evidence of failed delivery. Missing native installation evidence reports
`unsupported-capability` rather than manufacturing a native identity.
These command names and receipt fields are a **locally parent-proven source
integration target**, not evidence of a published compatible native SDK or
real-device mutation. The native MCP fenced tools report typed failures with
`isError: true` and `structuredContent.ok: false`; the nested error has
`code`, `retryable: false`, and an optional `operationId`. Their success
result shape is unchanged.
Mobile Canvas uses the verified CLI transport and retains its existing
public tool response shape.
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
The local fenced app-action source and synthetic two-host checks do not
activate those capabilities in the absence of the reviewed compatible public
CLI/Host graph, authoritative native evidence, and refreshed complete native
assets. All these limitations fail explicitly without fallback; this is not
real-device mutation proof or a release-ready package.

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

**The official SDK source/package pin is now present.** Both manifests and locks
pin `@ailoha/cli@0.2.5-preview.3`; `lib/ailoha/runtime-package.json` records its
actual public npm URL, SHA-512 SRI, source
`d1d16d142b110406c6070665db9222d424983aa9`, and publication run `40706552606`
attempt `1`. The downloaded root is 999,818 bytes with SHA-256
`fed271d89317a75e2cc2fd551e86c48e3c80d93f72c2ce28f8755ba3826dc38f`.
This is the actual anonymous registry publication, not an earlier local pack.
It covers five Target Host RIDs and six CLI packages; Linux musl is CLI-only,
and Windows ARM64 remains deferred. Missing official graph/pin still reports
`ailoha_runtime_unavailable`. Normal installs must
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
or symlinks. Ancestor path aliases (such as macOS `/var` and `/private/var`)
are canonicalized at the SDK graph root before resolving bundled dependencies;
symlinks inside the graph and hoisted replacements remain rejected.
Both archive verifiers compare the complete staged tree with its
deterministic byte fingerprint and require matching package/runtime source pins,
dependency versions and notices. A receipt checks staged-byte consistency; it
does not by itself establish anonymous publication of the upstream tarball.
Both archive verifiers also require matching source run/attempt in the native
CLI and Target Host attestations. VS Code locks the same official graph but
ships it only once under `dist/node_modules/@ailoha/cli`, without a second
partially filtered root copy. VSIX validation
permits upstream source maps only inside that verified pinned graph, preserving
the publisher's bundled bytes; Mobile Canvas source, tests and generated maps
remain excluded. Required native RIDs and public pins remain upstream release
evidence, not consumer assumptions. Restore dependencies with
`npm ci --ignore-scripts --omit=optional` (and `--prefix vscode` for that host)
when doing metadata/package-only qualification. Imports and pin-file checks
do not call acquisition APIs. In particular, even `getRuntimePin` can lazily
acquire native bytes; it, `getVerifiedCliLaunch` and `ensureTargetHost` are not
metadata-only probes. Public native acquisition/start, both normal installed
hosts, and refreshed Mobile Canvas embedded-web release artifacts require
their own qualification; legacy defaults and all capability gates stay intact.

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
Boot, shutdown and restart actions forward their caller signal to lifecycle;
after acceptance a cancelled waiter cannot claim late success or evict the
original receipt, while a live peer or later caller can confirm it without
another mutation.
Terminal creation failure/cancellation and unknown acceptance remain retained;
cancellation is not rollback. Success requires a correlated terminal operation,
the exact created type/runtime/template/name, running state and authoritative
virtual-device native identity. Errors retain operation metadata and any
attributable `createdTargetId`; no client-side destructive cleanup is attempted.

Creation accepts a host-only `signal` option through the direct backend, canvas
action, compatibility API and named MCP dispatcher. Cancellation received during
snapshot/catalog preparation prevents admission and removes only that caller.
Same-key callers share preparation and confirmation; one cancelled caller cannot
abort another active caller's intent. When the last caller retires, its owned
submission signal is cancelled, but an accepted or uncertain receipt stays bound
to the original compatibility tuple. Late accepted Location metadata remains
recoverable through GET/wait, never a new create/start. Cancelled callers do not
apply late selection; an active recovery caller still uses the original selection
snapshot and owner checks.

The loopback host installs each request's disconnect listeners before body or
backend awaits, checks already-aborted/destroyed state, and removes listeners on
completion. Normal completion of the request body is not cancellation. Scoped
host request/action options keep caller cancellation separate from shared backend
initialization and lease lifetime. VS Code API requests use a bounded per-request
controller and `api-cancel` IPC message; its Ailoha adapter invokes the same
trusted, scoped backend API directly rather than waiting for a later loopback
disconnect. Named MCP tool calls reject a closed owner or already-cancelled caller
before shared backend acquisition, and check again after acquisition before
dispatch; one cancelled waiter cannot abort a live peer's acquisition.
Legacy HTTP behavior is unchanged. HTTP cancellation tests observe
the captured signal before releasing a held native read: a client-side abort and
immediate fixture release cannot prove when a remote TCP disconnect was received.
No event-loop delay, grace period or atomic remote-cancellation claim is added.

### Device feature compatibility (source-gated)

The shared `device-features.mjs` adapter serves both installed hosts through the
official Target Host owner transport; it never starts a second provider, runs a
native shell, or invokes the legacy engine in the opt-in. Every enabled feature
requires an advertised target **and provider** operation, a running virtual mobile
target with a native identity, and the captured view's original context and
connection incarnation. Reads reject malformed or cross-target result context.
Canonical feature responses may carry only `targetId` (their `providerId` is
optional), so a target-only response is followed by an authoritative target
read to confirm the original provider and native deployment before projection
or mutation dispatch. A supplied but mismatched provider is rejected.
Mutations retain captured receipts across accepted-operation polling or failed
settings readback; an unknown submission cannot be replayed as a new mutation.
The shared typed HTTP rejection policy evicts only proven pre-admission 403
responses; 408 and responses carrying accepted operation evidence retain the
original receipt without replay.
Terminal feature completion must retain the accepted operation ID, kind,
non-destructive effect, target, and provider before releasing its receipt;
conflicting completion is rejected while the original ID remains recoverable.
Caller cancellation before feature admission blocks a new submission after app
lookup or target verification; it does not discard already submitted work.
Accepted confirmation is shared and caller cancellation stays local. A
completed result remains recoverable without another POST until a live caller
returns it, after which a new explicit mutation can proceed.
The MCP names, request fields, and legacy output envelopes remain unchanged.

| Existing identity | Opt-in delivery | Canonical contract / gate |
| --- | --- | --- |
| `mobile_device_battery_set` | Gated; source-conditional | `target.battery` PUT `/battery` takes legacy integer percentage as ratio, then `target.hardware` readback. Reviewed runtime PUT source exists; compatible public SDK and native acceptance are pending. |
| `mobile_device_hardware_get` | Enabled with `target.hardware` | `GET /hardware`; nullable battery/network values and `unreadable` are retained; battery ratio maps to legacy integer percentage. |
| `mobile_device_network_set` | Gated; source-conditional | Reviewed-source `target.network` PUT `/network` updates Android `latencyMs` with `target.hardware` readback. Reviewed-source native `applyTargetNativeNetworkProfile` POST preserves raw/shared profiles on both platforms and combined Android latency; its accepted result and indicator must agree with hardware readback, without POST replay after failed confirmation. Public SDK and native acceptance are pending. |
| `mobile_device_location_set` | Gated; source-conditional | `target.location` PUT `/location` verifies a 200 simulated fix but preserves the legacy success-only result; no unreadable location is fabricated. Public SDK and native acceptance are pending. |
| `mobile_device_location_clear` | Enabled with `target.location` | `DELETE /location` requires a completed 204; no simulated fix is fabricated. |
| `mobile_device_clipboard_get` | Enabled with `target.clipboard` | `GET /clipboard` only when the content is `text/plain` with a reported `text`. |
| `mobile_device_clipboard_set` | Gated; source-conditional | `target.clipboard` PUT `/clipboard` sends `text/plain`, verifies returned text, then reads `target.clipboard` again. Public SDK and native acceptance are pending. |
| `mobile_device_biometric` | iOS match/nomatch enabled with `target.biometrics`; Android gated | `POST /biometrics/results` confirms completion; `confirmed` remains false on iOS, which cannot confirm the scan listener. Reviewed native draft source supplies Android `confirmed` evidence and optional `fingerId` forwarding; Android remains gated until public SDK and native acceptance. |
| `mobile_device_call` | Gated; source-conditional | Reviewed native draft `controlTargetCall` accepts place/accept/hold/cancel and completes with full `TelephonyState`; source confirms the operation before projecting the unmodified Android call list. Missing readback does not replay accepted work. Public SDK and native acceptance are pending. |
| `mobile_device_calls` | Gated; source-conditional | Reviewed native draft `getTargetTelephony` supplies the full Android call list, native platform and raw states. The source requires every field and checks original target ownership; an absent native list is unsupported. |
| `mobile_device_sms_send` | Enabled with `target.telephony` | `POST /telephony/sms`, confirmed by the matching terminal operation. |
| `mobile_device_notification_push` | Enabled on iOS with `target.push` and `target.apps` | Resolve exactly one installed app by `packageId` through `GET /apps?includeSystem=true`; use the returned `appId` for `POST /push/notifications` and confirm the matching terminal operation. Workspace IDs are never substituted for native package IDs. |
| `mobile_device_permission_list` | Gated; source-conditional | Resolve one installed native package to its canonical app ID; reviewed native draft permission state supplies each `platformName`, with unknown reported as nullable `granted`, never denied. Public SDK and native acceptance are pending. |
| `mobile_device_permission_set` | Gated; source-conditional | Resolve the installed app ID, send reviewed-source PUT `/permissions/{name}` with grant/revoke/reset mapped to granted/denied/unknown, and require native `affectedPermissions` readback of all touched grants. Missing fanout retains the uncertain receipt, never replays PUT. Public SDK and native acceptance are pending. |
| `mobile_device_settings_get` | Enabled with `target.settings` | `GET /settings/device` projects the nullable appearance/accessibility fields. |
| `mobile_device_settings_set` | Enabled with `target.settings` | `PATCH /settings/device` requires the device namespace and reads back the resulting settings. |

The official preview3 graph is now pinned as described above; that source/package
qualification does not enable these feature flags or prove native feature parity.
Enabling PUT-dependent features still needs exact official runtime and target
capability support, not a fixture-only verb. Historical source qualification
used runtime PR 67 at `5abe074c7a91bb64aaf2691300e4bd39e9807079`, which
includes the fixed PUT method/type/private guard and is merged at
`1c82c6b65b9ef099f49f42386bd0e875c91b3339`. Reviewed native PR 76 source
at `00c8eda7e9e01145e0493d2ed45d2a455042d71d` includes the fidelity
fields; its current draft head is `75b165e2c51bb194980d5a88c0acc47de8d05eef`
after a normal merge of main. Those historical draft heads are not the current
public SDK pin and their fixture evidence is not installed-host acceptance. Internal
source-only fixtures explicitly enable these contracts and exercise 21 API plus
21 MCP feature cases in **each** thin-installed GitHub and VS Code host (84
positive invocations total), along with missing-generic-evidence negatives.
Production flags stay off; these synthetic checks are not native device acceptance.
Network `profile` is also gated independently of PUT until its separate,
new native-profile contract is published: the current canonical update accepts
latency but no profile, and the existing generic profile endpoint supports
Android predefined names only. Returning a latency-only result for a profile
request would change the legacy meaning.

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

The GitHub plugin's unmodified `.mcp.json` launches without context arguments.
In Ailoha mode this entry initializes with an empty tool list and directs
callers to the SDK extension's session-owned tools; it does not acquire a
runtime, infer the first panel or register duplicate global tool names. An
explicit but incomplete named-flag invocation still fails closed. Complete
named flags retain the standalone dispatcher for VS Code and other trusted
launchers. The SDK extension registers 64 descriptors before any view opens;
execution requires the actual SDK invocation session ID plus the caller's
explicit `instanceId` of an opened canvas. It reads that view's canonical
binding without create/reopen authority and forwards to the same bound MCP
dispatcher. The installed plugin contributes canonical `mobile_device_*` /
`mobile_app_*` SDK names; a source-local extension inserts `_local` after
`device` or `app` so both registrations coexist without duplicate tool names.
Both forward to the same canonical dispatcher identities. Closing a view
retires its requests and dispatcher without affecting another view. SDK-tool
and canvas backends use separate private lease consumers even for the same
canonical context; releasing one cannot tear down the other's transport.
A same-instance reopen waits for SDK request retirement and host closure, then
reuses the view host's retained receipt/coordinator state for GET recovery. The
SDK tool owner separately retains its private backend receipt/coordinator
state across dispatcher disposal and explicit same-view reopen, so an accepted
MCP operation also recovers by original-ID GET instead of another POST.
Failed SDK lease cleanup keeps the retired view and dispatcher reachable; a
new explicit same-instance open retries that cleanup once before reopening,
and another failed retry leaves the view closed with its receipts intact.
Every explicit open is registered before waiting on earlier cleanup. A later
close fences queued opens without waiting for an open that is itself waiting
on that close. If acquisition already started, close waits for it to settle
before releasing the lease; neither path can register a late SDK owner.
Neither in-flight close nor failed cleanup admits SDK tools.
VS Code similarly retains a failed retiring bridge. A new explicit view
resolution retries that exact bridge's cleanup before admitting its replacement;
overlapping retirement and stale resolutions cannot retry or replace it.
Disposal failures are reported through the VS Code output channel.
Session shutdown attempts every SDK and canvas owner before reporting failures.
Neither lease ownership nor receipt state is projected into the tool result.
SDK tool results retain screenshot image bytes and failure status; absent genuine MCP
form elicitation, destructive MCP requests
report `consent_not_supported`, not a simulated approval. Legacy launch and
tools remain unchanged. VS Code supplies its actual window/view binding and
refreshes definitions after a genuine context open. Binding discovery itself
cannot create or reopen authority: before a trusted view opens it reports
`context_not_bound`, and a retired view reports `context_retired`.

### Optional selected-view App MCP reads

Only the explicitly named Ailoha MCP profile appends `mobile_app_tree`,
`mobile_app_query` and `mobile_app_status` to the unchanged 61 legacy
`mobile_device_*` tools (64 in that profile). The legacy backend, catalog
JSON and compatibility baseline remain at 61. Initialize guidance distinguishes
provider-owned device tools from these optional native-instance App reads.
Choose and verify an instance in the UI first; MCP exposes no binding writes
or mutable App actions.
For host-owned SDK bootstrap, `ailohaAppMcpCatalog()` exports these same
three fresh descriptors without needing any view authority or native runtime;
it can be combined with the unchanged legacy catalog. Only execution requires
a real trusted named binding, never a dummy dispatcher for schema discovery.

Tree accepts only optional `maxDepth` in 1..16 (default 6); query accepts only
literal `type`, `automationId` and `text` filters of at most 128 characters,
with at least one nonempty filter; status accepts an empty object. None
accept session/view/context/owner, target/device/surface, application/agent,
route, port or endpoint selectors. All advertise read-only, non-destructive
annotations and `taskSupport:forbidden`.

Each invocation creates an independent reader using the same runtime semantic
factory and controller as the UI. It captures the current named context and
verified native instance, invokes canonical composed tools with
`require-agent`, then validates the same context/target/surface/runtime and
provenance before releasing the result. Output includes scope, selection,
operation and the bounded shared result (at most 300 elements, 16 levels,
512 characters per element field and 1 MiB encoded result). Missing, stale,
disconnected, retired or mismatched App ownership returns MCP `isError`;
it never falls back to System, another agent or legacy. Cancellation and MCP
shutdown retire the captured read and close its canonical child. App reads
do not acquire the device backend, follow/select a device, emit automation,
or request approval; the VS Code proxy also never follows a device supplied
in a rejected App read.

Prepared stdio tests exercise both host entry scripts with explicit trusted
launch flags and UI-selected context bindings, including isolation between
two views, absent/disconnected agents, selector/task rejection, cancellation,
and independent device reads. The prepared GitHub host also tests the exact
no-argument `.mcp.json` shape, SDK-double registration and opened-view calls
without launch flags, image/failure projection and two-view isolation. These
are synthetic source/adapter proofs, not an installed production SDK session,
published runtime or real-app acceptance.

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

Creation and direct lifecycle submission share one definitive-rejection policy:
HTTP 408, HTTP 499 and a disposed client retain the original uncertain receipt
and cannot authorize replay. HTTP 403 and known pre-admission protocol failures
may release only the same receipt identity. A trusted approval budget that
expires before the client is invoked is also pre-admission; once invoked,
unknown outcomes remain owned. Creation keys stay bound to the original
compatibility-choice tuple, with the shared 64-receipt admission bound.
Preparation observes even immediate submission failures before handing off the
receipt; an admitted intent counts only once against that bound.

PNG capture validates its 201 artifact/Location, ownership, MIME and applicable
size/digest before reading content. Video session creation preserves omitted
encoder settings; the renderer receives only owned session/geometry/source
projection and ALHV units. Host callbacks buffer bounded early messages before
that descriptor. Created sessions register captured cleanup: socket close,
session DELETE, then authoritative operation wait before lease release. A lost
202 cleanup body retains validated operation Location and retries only GET/wait,
never DELETE or a broad 404-as-success fallback. Unknown create outcomes cannot
automatically create a replacement on close/reopen.

Recording preserves the Mobile Canvas `recording/start`, `recording` status and
`recording/stop` API paths and the three MCP tool identifiers/output fields.
Only a booted virtual iOS simulator or Android emulator whose exact target type
and surface advertise start/get/stop recording is eligible. Recording is enabled
only if the pinned, verified CLI additionally advertises exactly one
`recording recover` entry marked `mutating: true` in its bounded offline
`commands --json` metadata. Missing support disables new recording and its
capability projection (including when a first target-only SDK advertises capture);
invalid or unreadable metadata is an explicit error, not a silent fallback.
The renderer can still read canonical recording status for its selected device;
the missing recovery capability never authorizes a new start.
An already-owned recording remains finalizable through its captured coordinator
even if a replacement backend cannot advertise new recording. The verified Ailoha
CLI's scoped recording coordinator owns cross-process acceptance markers,
operation reconciliation, stop and bounded artifact download; Mobile Canvas
does not implement provider recording or forward a credential to the renderer.
Start synchronously snapshots and validates the caller's timeout and host MP4
destination before target preparation can yield; MCP start additionally captures
the device selector before awaiting backend initialization. It also captures
the context ref/epoch/revision and host/target/surface. A lost start response
is not submitted twice. Caller cancellation or view retirement before CLI
dispatch blocks a new start; cancellation after dispatch does not
abort or retarget an accepted recording, but the cancelled caller cannot receive
a late success. The view retains that captured owner
across runtime lease replacement and selection changes. Stop uses the original
bound owner even after selecting another target; failed finalization/download
remains visible and prevents the canvas lease from releasing. The canonical
active status or an existing-marker refusal is observational only for a second,
untracked host, even within the same view: it does not acquire cleanup authority.
That host cannot automatically stop on close or explicitly stop without its own
validated original recovery receipt. The retaining host alone finalizes its
accepted recording, including its own lost-start acknowledgment. The canonical
CLI's recover-only operation is required after even a successful legacy stop:
Mobile Canvas releases the owner only after a matching durable downloaded
receipt proves the original context, host incarnation, recording and stop
identities, nonempty landed artifact and output. A lost or failed stop/download
response retries only captured recovery, never a second stop. Pending, failed and unknown
recovery outcomes retain the owner and block lease release or another start.
A cancelled status, stop or competing start retry does not claim a completed
receipt, while a live caller can recover the original stop without submitting another one.
A file at the output path alone never proves completion. A pending start may
have no recording ID; only the first authoritatively known ID is pinned.
The Ailoha MCP status tool advertises `readOnlyHint: false` because status
after a stop may recover and write that original output; it never deletes a
target or overwrites an existing recording. The legacy catalog is unchanged.
This source behavior requires the separately reviewed native recovery contract
and a compatible public SDK pin; the current opt-in remains unavailable without
those prepared public inputs.
The default host output is a unique MP4 under
`~/.mobile-canvas/artifacts/recordings`; explicit absolute MP4 host paths are
accepted, but the canonical landing refuses an existing file rather than
silently overwriting it. No remote/storage fallback is attempted. MCP process
exit releases its own lease without finalizing a recording that belongs to the
still-open view; view close/suspend finalizes before lease release.

Hide/close/dispose retires only that view's sockets, receiver, decoder and owned
resources. The shared host/broker/devices remain running. Provider state and
description are projected separately from a connected control plane; unavailable
tooling is not a ready-shaped empty inventory.

### Scope and verification

The nine legacy file/media/diagnostics identities remain registered with their
original MCP input/output schemas. Four read-only identities (`file_list`,
`log`, `crashes`, `crash_report`) now have shared, capability-checked source
adapters for the reviewed native read-result subset. File push and media add
now have source-compatible staging, conditional on the
verified native-stage CLI, target capabilities and original-owner receipts.
File push requires captured human overwrite approval; unsupported MCP clients
cannot substitute `confirm=true`. File pull, delete and mkdir still return
`artifact_contract_unavailable` (501) without dispatch because their direct
native routes lack a server-owned original-view admission and recovery fence.
Unadvertised read capabilities return `capability_not_supported` (501).
Ordinary installs still use the legacy backend unless explicitly opted in.
This is **not** nine-tool file/media/diagnostics parity.

The read adapter requires the captured target/provider/native identity and
original context revision before each new native read and again before
projecting a completed result. It refreshes the named view and native target
after an in-flight read, so retirement, revision changes and native identity
replacement cannot produce usable stale output. App selectors resolve
through the installed-app inventory to its package ID, not a workspace ID.
It rejects incomplete listings/totals, foreign entry ownership, unsupported
native query bounds and ambiguous app selectors rather than fabricating
results. File sizes include legitimate zero-byte files; native modification
and platform path spelling are retained. Native log query results preserve
the backend's chronological retained window and pre-limit total; blank text
retains the native no-filter semantics. Inline
crash detail is bounded to 1 MiB UTF-8; larger reports are not silently
truncated or marked successful. A streamed export/readback path remains a
delivery gate.

The read adapters target the coordinator-reviewed **source** subset frozen at
`microsoft/ailoha` native draft `2618b6c`. The staged push/media adapters use
the separately source-cleared typed stage, confirm, continue and cleanup
receipts at native draft `e003ea7`; incomplete artifact readback confirms
by original-host GET only, uncertain device acceptance never triggers another
device POST, and original-host cleanup is receipt-conditional. A completed
zero-byte push is distinguished from a failed copy; media output requires the
native accepted artifact IDs in stage order. Relative host source paths resolve
to absolute paths in push/media output, matching the legacy service. Media
batches beyond 16 paths
fail explicitly instead of silently truncating. These are **source-only**
compatibility paths, not a public SDK/runtime pin. The normal Ailoha opt-in
remains unavailable until an approved public runtime graph is prepared; no
public binary, real-device parity or default migration is claimed.

The locally implemented guarded pull, delete and mkdir adapters prepare
against the original named view and native owner and recover accepted
operations by original-operation GET without resubmission, even if the view
retires after admission while the owning backend remains active. New admission
remains bound to the open original view; cancelled readback retains the accepted
receipt for later recovery, but disposal cannot launch new CLI work.
Pull projects only the backend-confirmed export `devicePath` associated with the original
operation's artifact, actual verified byte count (including zero), and native
resolved absolute host destination. The canonical CLI owns bounded streaming,
SHA-256 verification, destination overwrite and repeat-readback checks; JS
never downloads or substitutes a guessed source path. Delete and mkdir require
backend-confirmed mutation paths on terminal success, correlated with the
original operation result. Pull and delete require scoped human approval;
a literal confirmation flag is not approval. The
corresponding GitHub API and VS Code API/MCP routes are conditionally mapped
in local source only, pending consumer review and publication against the
reviewed native source. No public native runtime pin or device execution is
claimed.

For comparison, at the earlier canonical `microsoft/ailoha` source
`f5eadd9f7a31b6da9322bf74e7549286d8844668`, the root Target Host feature
API and provider adapter did not yet supply the legacy guarantees below.
The conditional read subset above now uses newer reviewed draft source; this
historical table does not describe the currently mapped read routes:

| Legacy surface | Missing native compatibility semantics |
| --- | --- |
| File list | A resolved listing path, complete total and reusable per-entry paths. The provider limits results to 5,000; an array length cannot stand in for an uncapped total. |
| File pull/push | Completed host destination/overwrite and verified transferred byte count, including successful zero-byte copies. The root API exports/imports artifacts and returns operation receipts, not completed transfer results. Push must not be replayed after uncertain acceptance. |
| File delete/mkdir | Nonrecursive directory-delete refusal and scoped human deletion consent; the current provider forces recursive deletion. The reviewed root file-service contract does not expose a compatible mkdir and resolved-path result. |
| Media add | A host-path list with accepted-path result and iOS vCard handling; root import takes a single staged photo/video/audio artifact. |
| Log | Device-side text filter, complete match total, guaranteed newest-first ordering and process/subsystem fields. Root log query has app/level/time/limit but no text or total. |
| Crash list/report | Process-name text filter, complete match total, guaranteed newest-first ordering, and full detail content. Root detail is a summary; full content is a separate artifact export. |

The root Target Host supports `app://<bundleId>/<relative-path>` and absolute
device paths in its file adapter, but that address mapping alone cannot repair
missing result fields or policy. The `imports/mobile-canvas` subtree contains
the historical API and contracts; calling its standalone service instead of
the root Target Host would reintroduce a second native engine. The required
native work is to expose exact result/filter/ordering evidence and a
lease-owned, server-fenced staging and artifact flow before enabling any of
these identities. Neither a bounded JSON body nor a successful operation
receipt can prove a completed copy or justify invented output metadata.

Implemented: authoritative advertised catalogs and compatible create+boot,
inventory/select, advertised start/stop/reboot and provider-owned window reveal,
PNG screenshot,
basic geometry-bound pointer gestures, shared ALHV WebCodecs display, and
advertised reset/delete when the host can obtain genuine captured approval,
target-host recording through the verified scoped CLI when it advertises
canonical recovery, [read-only explicit-root workspace/application evidence](ailoha-workspace-inspection.md),
and read-only canonical composed `app_tree`, `app_query` and `app_status`
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
source-only slice provides optional explicit native-instance binding in the
same shared semantic panel in both hosts. **Read registered candidates**
uses only an advertised read-only `agent candidates` command, with the exact
captured host/target pair. Its `ailoha.agent.candidates/v1` success envelope
contains only registration version 2 identities (or an empty array).
`ailoha.agent.candidates/v2` success requires at least one version 3 identity
for **that selected pair**, and may also contain known version 2 identities.
Both preserve the exact pair, explicit `ok:true`, `error:null` and at most
256 candidates. Each candidate has exactly `agentId`, `runtimeInstanceId`,
`registrationVersion`, `targetHostId` and `targetId`; its agent ID must equal
`agent-<runtimeInstanceId>`. Runtime IDs are 1..128 ASCII alphanumeric, `_`
or `-`; each target ID is a nonblank, noncontrol opaque ID of at most 128
characters, excluding `.` and `..`. The complete JSON is bounded to 512 KiB.
Unknown registration versions, v1 with version 3, v2 without version 3,
duplicate identities or JSON properties (including escaped key aliases),
partial/mismatched target pairs and extra private fields fail explicitly.
A linear raw-property scan limits JSON container depth to the canonical
three levels before adopting parsed identities. Canonical inventory validates at most 256 global
registrations and global duplicates **before** filtering; another target's
valid v3 registration must not break iOS/v2 discovery or change its schema.
Failures always use `ailoha.agent.candidates/v1`, `ok:false`,
`candidates:null` and exactly `error:{code,message}`, including failures when
enumerating v3 candidates. They retain the exact target pair; only
`AgentCandidatesRequestInvalid` can return both selectors as explicit nulls.
The legacy null-bearing fields remain required; a v2 failure or missing
null field is malformed, not a new failure-envelope variant. The verified
CLI preserves only a validated failure envelope on exit 1, without exposing
its diagnostic message. A successful empty
inventory is distinct from unavailable support or a failed read. Choose a
candidate explicitly, even when there is only one, then **Verify selected
candidate**. Advertisements are not live readiness or application mapping.
Alternatively, enter exact canonical v2/v3 `runtimeInstanceId` and `agentId`
from trusted registration evidence and choose **Verify and bind**.
A host-issued token captures this named view's
context, epoch/revision, owner process, target pair and surface; Ailoha
`context select` performs complete-tuple CAS with `applicationId:null`.
Only a response preserving both IDs, the captured target/owner and
`verified-native-instance` / null application evidence enables the App lens.
**Clear native binding** performs target-only selection using the same CAS,
leaving device-only System inspection available. Selection changes, view
suspension and cancellation retire pending results and binding tokens.
Canonical failures are explicit and never route to System as a fallback;
uncertain binding writes are not replayed. **Read current binding** reads
the same canonical context consumed by bound MCP operations.
An agent disconnect/restart fails App reads explicitly but does not make
provider-owned device reads or an explicitly chosen System lens depend on
that agent. Target Host routing marks both agent selectors as not requested;
it still validates the original host, target, surface and view authority.
Clear remains available after App failures: target-only `context select`
validates the new null-agent tuple, not the old agent's liveness. A dead
trusted host/context owner is a different failure and must not be bypassed.

Older runtimes (including preview2) without the advertised command show
candidate enumeration as explicitly **unavailable**, not an empty inventory.
The runtime SDK has no read-only enumeration API; this command is a
separate source-only engine prerequisite and requires an approved published
pin before real acceptance. The reviewed canonical inventory source is
`microsoft/ailoha@a53d2070830cad1f2b425a57eff421cbd25a5afa`; this is not
an approved runtime/package pin. `agent list` may start the broker or scan the current workspace, and
`broker status` / MCP human-text empty results cannot distinguish failed
inventory from zero agents. This workflow never calls them, reads private
broker configuration or credentials, guesses an endpoint, selects the first
agent, or correlates package/path/name/port to a runtime. Candidate tokens are
private to one captured view read; another view, a target/process change,
suspension, or a newer candidate/inspection read cannot reuse them. There is no
workspace-application-to-native-agent mapping.

The Android app-transport v3 contract below was first admitted as a local source
compatibility target. The current official preview3 SDK graph is now pinned,
but that source/package qualification does not prove installed Android behavior.
Broker registration
uses `registrationVersion:3` and `endpointScope:"target-guest"`; the runtime
and Target Host own the actual guest port, ACK and transport negotiation.
None of those transport/endpoint fields, raw serials or private owner stamps
belong in candidate projections, binding arguments or MCP tool inputs.
The existing canonical context selection and three composed App reads carry
only the exact identity and captured context; no caller transport selector,
new public transport tool, Android host-loopback, System or legacy fallback
is introduced. Host, provider and target must explicitly advertise
`target.agent-transport` version 1 with both `getTargetAgentTransport` and
`exchangeTargetAgent`. The canonical layer performs this live negotiation;
candidate discovery is not capability or live-runtime verification.
`AgentTransportUnsupported` and `unsupported-capability` remain sanitized
typed 501 failures; `AgentTransportStale` remains a typed 409 refusal rather
than a guessed replacement owner. Unverified native identity and disconnected
owner errors remain explicit. Binding/refused reads are not retried.

Shared source tests exercise version-aware discovery, exact binding, named
GitHub SDK tools, real JS SDK stdio MCP calls, and the compiled VS Code
bridge with synthetic canonical peers. This is not actual Android runtime
acceptance. React Native Android adopts the upstream transport first;
standalone Kotlin remains legacy and managed MAUI Android transport adoption
is not implied. iOS/v1/v2 behavior, tool catalog identities (64 opt-in /
61 legacy), runtime/package pins and production defaults are unchanged.

Named App CLI results also consume the existing invocation metadata carrier:
stdout and the typed error payload remain unchanged, followed on stderr by
exactly one `_meta` notice with `ailoha.executionContext` and, only after an
exchange exists, optional `ailoha.agentExchange`. The shared reader frames
bounded JSON objects rather than skipping log lines or assuming all JSON is
single-line. Compact and pretty records are accepted; extra/duplicate notices,
escaped duplicate properties, unrelated stderr and malformed metadata fail
explicitly. This reader is restricted to `app` commands; candidate failures
remain one isolated v1 JSON object. Trusted callers provide their original
snapshot/scope internally as `metadataContext`; returned metadata never
supplies selection authority.

The native context DTO is validated against that original ref, scope,
epoch/revision and complete invocation selection before projection. Only
bounded context identity/selection and the sanitized exchange receipt are
public: observed/provenance blobs, owner stamps and connection evidence are
not copied. The receipt contains a native-generated 32-lowercase-hex
`requestId`, boolean `commitAttempted`, `admitted`, `completed` and
`effectMayBeUnknown`, plus optional bounded `errorCode`. The consumer does
not know the native per-HTTP ID before invocation, does not equate it with
an MCP tool ID, and does not invent independent correlation. Admission
requires a commit attempt; completion requires admission; unknown effect is
exactly `!completed && (commitAttempted || admitted)`. An original incomplete
receipt never authorizes replay or a replacement context.

Canonical stdio MCP `_meta` passes through the same validation and public
projection. Recognized canonical root errors are preserved, while receipt error codes
recover typed failures from generic/unrecognized SDK-wrapped human error text.
For example, `ContextRevisionConflict` may legitimately carry a diagnostic
`not-admitted` receipt; neither original evidence is rewritten. The receipt survives `MobileAilohaError`, semantic state,
named App MCP errors and cleanup failures. A retired read may return its
original failure receipt to its original caller, but cannot repopulate the
hidden/replaced view or restore App availability. CLI cancellation retains
an already received complete notice and waits for its owned child to close;
it never fabricates a receipt for a call that failed before capture.
Canonical `ContextClosed` errors remain a specific 409 refusal with a fixed
public message, not a generic inspection failure. A refusal before native
capture has no `_meta` or exchange receipt; none is invented. It never
reopens, retries or falls back, and a late refusal cannot restore a retired
view. This normalization does not change MCP startup/transport failures.
Successful `route.executionContext` uses the same captured-context projection
as `_meta`, rather than forwarding the native invocation object. The host
first validates private route owner, target/surface, context identity/scope
and native-instance evidence. It then publishes only `contextRef`, the
two-key `scope`, `scopeEpoch`, `revision`, and a verified seven-key
`selection` when the native route provides one. Native nullable omissions
become explicit nulls; System `target-host` selection has null agent/runtime
IDs even when the view also has an App binding. Older minimal routes without
selection stay supported without inventing a native selection.

Public route scalars are limited to owner, operation, reason, description,
target/surface IDs, agent/runtime/legacy IDs, registration version and
correlation. Unknown native route/context/scope/selection blobs and
`capturedAt`, native `observed`/`provenance`, owner stamps and connection
evidence are never forwarded to renderer or MCP. This does not remove the
existing controlled three-field host `result.provenance` DTO. Invalid
private evidence or contradictory selection still fails before publication;
projection is not a substitute for authority validation. Genuine received
`_meta` receipts remain unchanged, and no metadata or receipt is synthesized
for a success that supplied none.
The three
legacy `mobile_device_ui_dump/find/tap` identities remain installed. The
source-only `microsoft/ailoha@5a99822fbbaa4780aa6cc196c9442496c89a06f6`
contract qualifies the consumer mapping for review; it is not a shipping
allowlist for that exact Git SHA. A coordinator-approved published SDK/native
version and source pin must first pass the official runtime verification.
Targets and surfaces must then positively advertise `surface.ui` operations
`getSystemUiSnapshot`, `querySystemUi`, and `tapSystemUiMatch`, and responses
must pass typed owner and bounded-shape validation. Without a public pin the
opt-in returns `ailoha_runtime_unavailable`; an incompatible native UI
capability returns `capability_not_supported`, not App inspection results. The
shared projection uses only `/ui/system-snapshot`, `/ui/system-elements`, and
`/ui/system-elements/actions/tap`, never the App semantic lens or generic
`/ui/tree`. It preserves nullable frames with legacy computed `centerX` and
`centerY` on non-null frames, raw role/hint, explicit bounded
UTF-8 raw payload, full count before limit, and native `UiTree` paths (`0`,
`1`, `1/0`). Null-frame find centers remain zero as in the legacy projection;
tap sends a fresh UI revision with captured geometry and the original query,
defaulting `interactableOnly` to false so the first legacy match is not
substituted. The native owner performs the query and input under one lease;
Mobile Canvas never follows find with a coordinate POST. Changed view/native
identity/surface/process and uncertain tap outcomes do not authorize replay.
Native queries accept the legacy signed-int32 `limit` and return at most
`Math.Max(1, limit)` matches while reporting the honest full total; the native
source hierarchy is bounded to 8 MiB before search, and raw payloads to 1 MiB.
The consumer also rejects a System UI response body over 16 MiB rather than
silently truncating it; a larger result requires a reviewed native transport
contract, not client-side invented pagination.
Native tap keeps its completed original-owner receipt if its caller cancels
during authority read-back; a live peer may confirm the same result without
another tap, while a canceled peer cannot release that receipt.
This source-only consumer mapping is **not** proof of released SDK/native
compatibility, other-platform CI, or device validation.

Reveal requires advertised `target.lifecycle/revealTarget` and a running
provider-owned target, then calls only the canonical Target Host
`POST /api/v1/targets/{targetId}/actions/reveal`. The original named context,
provider, native deployment and private full process-incarnation reference
remain captured; a changed view cannot turn the result into a different
selection. A validated successful reply is retained privately through
read-back/selection errors and can be reconciled against the original authority
without another POST. A proven pre-acceptance refusal releases its receipt;
typed transport errors carrying accepted operation evidence are not rewritten
as definitive HTTP refusals, even if their status is 403. A canceled reveal
caller cannot select or discard a live peer's original completion;
HTTP 408, timeout, abort and other uncertain POSTs remain retained and are never
replayed, including
across same-ID process replacement. Stale authority and different process
incarnations cannot claim the retained completion. This is a source-only
compatibility path and depends on a matching released native runtime; it does
not perform local window-manager automation. Both hosts bundle the exact-pinned MCP client
graph, while the official Ailoha runtime pin remains a separate release gate.
Controlled native development CLI proof exercised System and explicitly bound
App tree/query/status through both prepared host clients against the real
canonical broker and mock Target Host/Core-MAUI agents, including stale-context
and missing-Agent failures. This does not qualify a public package, normal
installation, native platform matrix or real-device acceptance.
Unsupported: configuration-dependent creation, reset/delete without scoped
consent, app deployment without canonical staging, and broader operations
without their required native capability or compatible published runtime. No claim of
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
`{url, evidenceUrl, recording}`, then run the code file; it navigates once into
a fresh fixture host and verifies resource counts, pointer input and hide/resume.
Pass `--recording` to the server to enable synthetic recording support. This
also checks the prepared shared renderer's start/stop button and hide-time
finalization against its captured view, with recording output isolated under
the fixture's context directory. Run it against both prepared plugin and VSIX
roots; the compiled VS Code HostBridge is exercised by the separate installed
entrypoint fixture. Combine `--recording --lost-start` to lose the first
accepted start response: the renderer must offer captured resolution rather
than replay start, then finalize one recording and land its MP4.
The installed entrypoint fixture also rejects a changed host incarnation and a
nonzero typed download failure before retrying only the captured recovery;
each host submits one stop for that recording.
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

Agentless controls in the opt-in use the captured Target Host selection and
per-target/per-surface capability evidence, without an app agent: `pressTargetKey`
for numeric USB HID keys and physical button names, and
`updateTargetPresentation` for portrait/landscape rotation. Legacy button
aliases and case variants remain accepted (including iOS `side` and
Android `recents`, `app-switch`, `volumeup`, and `volumedown`); only recognized
names are sent as normalized canonical JSON.
The legacy `/presentation` API and MCP identity mean **status-bar overrides**, not
Target Host display presentation: they map to `getTargetSettings` and
`updateTargetSettings` in the `status-bar` namespace, preserving
`enabled`/`readable`/`overrides` semantics. Missing focus, capability, or
directional rotation support is explicit unsupported/error, never a fallback.
The Target Host only guarantees generic landscape and portrait; requests for
landscape-right or portrait-upside-down are not silently approximated.
Changes to orientation invalidate observed logical geometry; new pointer input
needs a fresh display observation. An explicit Ailoha rotation retires its
original ALHV player before submitting the canonical action, clears old pixels
and blocks coordinate input. Only an accepted rotation with settled geometry
and the same original view/selection may create one replacement video session;
input becomes ready only after a matching fresh frame is painted. Unknown or
refused rotation does not start another stream or replay input; explicit
user-initiated recovery first reads the canonical display and owner again.
View hide/resume releases only its own resource.
Both hosts share the control adapter and renderer; neither gains native
commands or credentials in the webview.

The official `@ailoha/cli@0.2.5-preview.2` transport accepts `PATCH` and
`PUT` as well as GET/POST/DELETE. A disposable TEST GitHub WebView exercised
one real Android rotation through that SDK: the original video POST 201,
old-video DELETE 202 and one replacement POST 201 were observed in order at
the original native request boundary. Fresh landscape 2400x1080 H.264 painted
at revision 2 without a presenter-contract error; the final owned DELETE 202
was observed on closure. HTTP statuses do not prove asynchronous DELETE
completion, nor does the observation qualify a real installed VS Code
extension window, GitHub app chrome or a production runtime pin.

The pinned Target Host `fill` implementation taps the field center before
typing, even when it was already focused. Unlike legacy `TypeTextAsync`,
successive character events or a paste can therefore move an existing caret.
The opt-in advertises `text: true` only when the target's `surface.input`
advertises `typeFocusedText` **and** the selected surface's `surface.input`
advertises `text`. Otherwise plain typing and paste return unsupported with
no input POST; the shared adapter retains `fillElement` only for an explicitly
named, observed editable element. The conditional source mapping follows
reviewed [microsoft/ailoha#73](https://github.com/microsoft/ailoha/pull/73): synchronous `POST
/api/v1/targets/{targetId}/surfaces/{surfaceId}/input/actions/type-focused-text`
with literal JSON `{ "text": "..." }`, no tap/refocus/clear, 1..4096 strict
UTF-8 bytes, valid Unicode and no NUL. The owner receipt must match the
captured target/provider/surface/geometry. Accepted failures are not retried
or sent through Fill/key/legacy. The first public SDK preview cannot advertise
this operation; actual activation remains gated on a reviewed compatible
public SDK/native Target Host and device verification. The native Android
backend explicitly rejects text it cannot transmit literally (non-printable,
non-ASCII, `%s`); Mobile does not approximate it.

`ailoha-creation-browser-server.mjs <prepared-root> <github|vscode> <context-file> [--focused-text]`
serves the complete shared renderer with synthetic catalogs/creation. Its VS Code
mode uses the actual compiled HTML builder, theme/transport scripts and HostBridge;
only the browser's stand-in for native webview IPC uses a test-only HTTP/SSE shim.
Run `ailoha-creation-browser-check.mjs` in Playwright with
`window.ailohaBrowserTestOptions` set to the emitted options. It verifies enabled
compatible create controls, both-platform payload/native IDs, real WebCodecs
resize/idle behavior, one video per creation handoff despite its selection echo,
stale-selection protection and zero leases/videos after hide.
The optional synthetic focused-text flag exercises positive per-character and
paste events; without it the old Fill-only target remains text-unsupported.
Neither mode proves a matching native/public SDK boundary.
Stop the helper to restore/remove its explicitly synthetic prepared pin.

```sh
npm ci --ignore-scripts --omit=optional
npm ci --prefix vscode --ignore-scripts --omit=optional
node scripts/prepare-plugin.mjs --thin
node scripts/prepare-vscode.mjs --thin
npm run compile --prefix vscode
node --test tests/scripts/ailoha-installed-host.test.mjs
node scripts/test-prepared-ailoha.mjs
node tests/web/ailoha-player-browser-server.mjs
```

The GitHub plugin tar disables macOS copyfile metadata for that archive command
only; its actual-archive test rejects AppleDouble entries and verifies
representative shared source bytes and executable modes.

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
When only a local `osx-arm64` build is available, use a tag of the form
`unpublished-review-<short SHA>` and append `--review-local-rid` to the
`prepare-plugin.mjs --runtime-dir` and `prepare-vscode.mjs --runtime-dir`
commands. This review-only mode verifies the current source fingerprint and
both local archive byte hashes, and permits exactly one `darwin-arm64` entry;
ordinary packaging still requires both macOS runtimes. Review-local-rid cannot
be combined with thin packaging. Verify the resulting
plugin with `node scripts/verify-plugin.mjs .build/copilot-plugin/mobile-canvas
--review-local-rid`, and a locally packaged VSIX with
`node scripts/verify-vsix.mjs <review.vsix> --review-local-rid`. Neither ordinary
verifier silently accepts an unpublished review bundle.
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

## Source follow-up after the immutable RC1

Preview loading/error/unavailable messages use the shared stage, not the
pixel-fitted device bezel. Long messages wrap and scroll with a reachable
44-pixel recovery action at narrow and wide sizes; hiding the status layer
restores normal device input.

An authoritative target error or unavailable provider disables boot and live
controls. Error state alone is not a blanket cleanup ban: delete remains
available only with an available provider, advertised canonical delete
capability and the existing explicit scoped approval/revalidation. No native
shutdown state is inferred. System live inspection requires the exact selected,
available running target; project reads and native-candidate metadata remain
independent.

Only the bounded, known native runtime-bundle boot failure is classified into
a fixed Xcode/runtime recovery hint. Raw commands, paths and stacks are not
rendered. Other failures retain their generic safe message/code. Ailoha
lifecycle error recovery refreshes observations rather than automatically
resubmitting the action. Original operation metadata, uncertain/mismatched
receipt GET recovery and verified-terminal release semantics are unchanged.
After a genuine runtime repair and fresh available observation, a new explicit
action can legitimately create a new operation.

These source changes are not present in the immutable `v0.1.19-rc.1` producer
artifacts. Shared web and embedded-asset inputs change the native source hash.
Use a freshly built matching unpublished local review runtime for source
package acceptance; do not restamp the old published manifest. A new published
producer remains a separate approval boundary.

### Fresh target catalog: source-only engine prerequisite

The original inventory performed a separate canonical capability read for each
target. In the pinned preview3 native runtime each such read can repeat native
device enumeration. The bounded-four follow-up reduced consumer serialization
but did not eliminate that amplification: retained real-backend qualification
of that follow-up still timed out. Its local review packages and failed native
evidence remain historical, not a successful installed-host latency result.

The replacement source contract is `GET /api/v1/target-catalog`, optionally
filtered with the exact opaque `providerId` query. The shared client negotiates
`target.catalog` version 1 / `getTargetCatalogSnapshot` on the host and every
selected provider descriptor, including unavailable or disabled providers.
Missing support is explicit `capability_not_supported` / 501; there is **no**
old list-plus-per-target-capability fallback. A missing selected provider is 404.

The exact response is:

```json
{
  "schema": "ailoha.target-catalog/v1",
  "capturedAt": "2026-10-30T20:06:34Z",
  "providers": [
    {
      "provider": "<existing ProviderDescriptor>",
      "targets": [
        {
          "target": "<existing TargetDescriptor>",
          "capabilities": "<actual per-target CapabilityDescriptor[]>"
        }
      ]
    }
  ]
}
```

The descriptor placeholders above stand for the existing JSON objects/arrays,
not literal wire strings. `capturedAt` is required RFC3339 UTC (`Z` or `+00:00`).
Unknown fields/schema, malformed descriptors, duplicate provider/target IDs,
foreign target-provider IDs, more than 128 providers or 4096 total targets, and
nonempty unavailable/disabled providers fail explicitly. All registered
providers must be represented in an unfiltered response. Provider failure,
cancellation or ownership drift fails the entire read, never a partial or
success-shaped empty inventory.

The engine obtains descriptor/surface/capability observations from the same
fresh provider enumeration per request. The consumer projects those supplied
target capabilities; it does not guess them from provider/surface capabilities
or refetch them per target. Optional recording eligibility still uses a
provider-type promise bounded to this inventory invocation. Response order is
preserved, and there is no cross-refresh, cross-view or global cache.
The read timestamp/envelope is not an atomic OS fence, token or authority for
later mutations. Selected action paths retain their existing fresh
target/capability checks, named-context generation, owner fences, approval and
accepted-receipt recovery.

Both hosts use this shared client/backend. Clearly synthetic source-contract
fixtures cover 54 targets, old-peer refusal, exact shape/bounds, failure,
cancellation and context retirement through shared HTTP/SDK/named MCP and the
compiled VS Code bridge. These fixtures are **not** published preview3/native
acceptance. The official SDK graph and `runtime-package.json` still pin
`0.2.5-preview.3` source D1/run407; that native peer does not advertise this
capability. New compatible native qualification/publication and an approved
official pin update are separate prerequisites before actual acceptance.
