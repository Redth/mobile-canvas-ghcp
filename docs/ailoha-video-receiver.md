# Shared Ailoha video receiver

`web/ailoha-video-receiver.js` is original Mobile Canvas code for the evaluated
`ailoha.video.v1` behavior. It uses the shared ALHV/1 parser. It is not a
transport, codec/player, runtime manager, routing policy, or production cutover.
No Ailoha source, schemas, or binaries are included, and this slice establishes
no redistribution rights or production artifact pin.

## API and ownership

Both the GitHub App canvas and VS Code webview must import this same module.
Their trusted hosts supply an already authenticated, owner-bound transport:

```js
import { createAilohaVideoReceiver } from "./ailoha-video-receiver.js";

const receiver = createAilohaVideoReceiver({
  context: { videoSessionId, ownerId },
  onFrame: consumeAccessUnit,
  onControl: applyVideoControl,
  onError: reportVideoError,
});
const connection = receiver.attach({
  protocol: authenticatedTransport.protocol,
  send: (text, scope) => authenticatedTransport.send(text, scope),
  close: () => authenticatedTransport.close(),
});
await connection.start();
// Forward messages immediately, in arrival order; do not convert Blobs first.
await connection.receive(messageData);
```

Send/close callbacks may complete synchronously or return promises. A throw,
rejection, or explicit `false` reports transport failure, not successful delivery.

The context is a frozen snapshot containing **only** nonempty `videoSessionId`
and `ownerId` strings, each at most 256 characters. The trusted host issues the
opaque owner ID for its captured view/target/surface context; the receiver does
not select or authenticate that owner. Credentials, endpoints, and mutable
selection state must not be added. A different session/owner needs a new receiver.
Context fields are captured once before validation, including accessor-backed
host projections.

`attach` snapshots `protocol`, `send`, and `close`, invalidates the previous
attachment immediately, and returns an independent handle. Transport fields are
read once; the same captured callbacks are validated and bound. `start()` sends
hello once; success means hello was sent, not that ready arrived.
`receive(string | ArrayBuffer | Uint8Array | Blob)` returns a promise resolving
`true` after the control is applied or the unit is consumed and its ACK is sent.
`false` means stale/cancelled/failed work; failures also invoke `onError`.
Invalid API configuration or command arguments throw.

`control("requestKeyFrame" | "pause" | "resume" | "cancel")` sends the exact client
control envelope, only after ready, without `afterSequence`. Completion confirms
the send, not a command acknowledgement or a frame barrier. It does not invent
paused/resumed state or assume a requested keyframe has arrived.
`close()` and `receiver.dispose()` are idempotent and abort queued/active work
before asynchronous transport cleanup. They release only this connection:
they do not delete the REST video session or stop devices/providers/other hosts.
Disposal permanently prevents attachment; normal close permits reconnect.

## Consumption and presentation

`onFrame(frame, scope)` must resolve **exactly `true`** only after safely
consuming/retiring the access unit. Throw, rejection, or another result is a
terminal consumer failure. Configuration-only units consume the window too:
cache/configure them and return true without waiting for a picture. Config and
picture units have separate sequences but can share a timestamp; a combined
config/key unit has one sequence. Timestamps remain `bigint`.

Every callback receives the original immutable context, an abort signal,
`isCurrent()`, and `commit(syncAction)`. Use the signal to cancel preparation and
the synchronous commit guard for decoder/presentation side effects after any
await. Guards expire when consumption completes, on close/replacement, or when
the presentation generation changes. The receiver cannot cancel external
promises or undo unguarded side effects; consumers must honor this contract.
Transport sends receive the attachment scope and must use its guard if they
defer the actual send.

Frame scopes also include `canDecode`, `canPresent`, and `needsKeyFrame`.
Fresh ready and a declared drop require a restart keyframe. Config can be cached
but does not clear that requirement. Retire units with `canDecode:false`
without decoding/presenting them; their commit guard is disabled. A positively
consumed keyframe enables dependent units. `canPresent:false` also identifies
config-only units, not pictures. No codec implementation is provided here.

Picture scopes also expose `retainPresentation()`. It returns an independent,
immutable owner/geometry guard for a bounded decoder handoff after the ordinary
callback scope expires. Only current, decodable picture units can retain it;
config-only units cannot. Call its idempotent `release()` when output is
presented/retired. Geometry/drop/replacement/close invalidates all retained
guards. Each attachment admits at most 64 retained owners and 16 MiB of retained
encoded payload; retaining ownership does not authorize later unguarded paint.

`scope.geometry` is an immutable, revision-bound geometry snapshot, or `null`.
Ready contains no bounds: reconnect reuses observed geometry only at a matching
revision. Disable coordinate use when null. An omitted bounds coordinate has
the protocol's window default. Geometry callbacks finish before affected frames;
old-frame consumption finishes before new geometry is announced.

ACKs strictly advance through actual consumed/retired units, never socket
arrival, picture count, timestamp, or a drop watermark. Already received units
drain in order before a discontinuity; only declared unsent gaps are skipped.
Reconnect honors the new ready floor, does not replay disconnected history, and
rejects rewind. Exhausted uint32 sequence space needs a new host-created session,
not wrapping, a keyframe request, or a different provider. A valid exhausted
ready floor is retained even though the attachment cannot stream; later
attachments of that same receiver cannot rewind it to zero.

## Bounds, errors, and integration

Each attachment bounds receive work to 32 messages and 16 MiB of encoded wire
bytes, including active callbacks. Controls are at most 64 KiB of UTF-8; payloads
use the unchanged 8 MiB parser bound. Typed-array payloads are copied once to
owned storage; immutable Blobs convert serially. Pending sends are serialized
and bounded to 32. Hello requests a window of 8; ready/backpressure is authoritative
within the receiver's finite capacity of 64, subject to the other local bounds.

`onControl` handles validated ready, geometryChanged, backpressure, and
nonterminal error messages in order. `onError(error, scope)` is a synchronous
notification callback; it must not throw. Errors expose `code`, optional `cause`,
and optional immutable server `control`/ProblemDetails. Only known diagnostic
extensions are projected. Nonterminal server errors preserve channel state;
terminal errors/cancelled immediately retire the attachment, including a pending
Blob/consumer. Malformed messages, overflow, callback failure, or send failure
stop and release it explicitly. There is no legacy retry.

Both packaging scripts stage this receiver beside the unchanged shared parser.
Prepared-asset tests import the actual GitHub plugin and VS Code copies, compare
both files byte-for-byte, and exercise synthetic host-style consumption, ACK,
control, geometry, reconnect, and stale-generation retirement. Plugin and VSIX
verifiers require the receiver; build checks validate its syntax. These checks
carry only the non-secret session/owner projection, not private HTTP credentials.

## Shared player and installed consumers

`web/ailoha-video-player.js` is consumed by the opt-in branch of the shared
device renderer in both installed hosts. It ACKs configuration separately and
ACKs pictures only after a bounded, owned WebCodecs handoff or safe retirement,
not by socket arrival or unconditional waiting for a displayed picture. This
lets a window of one progress when H.264 reorders/buffers output.

The player retains only eight pending pictures and 16 MiB of copied encoded
data, with a five-second output lifetime and bounded decoded dimensions.
The ALHV wire remains complete Annex B access units, byte-for-byte unchanged.
The decoder-local adapter caches bounded SPS/PPS, validates their identities and
required profile/chroma/bit-depth fields, and builds an
`AVCDecoderConfigurationRecord` for `VideoDecoderConfig.description`.
That description selects AVC under the
[WebCodecs AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/):
decoder chunks therefore use four-byte big-endian NAL lengths, not Annex B
start codes. Parameter-set bytes move only into the description; other NAL
bytes are preserved. A single AUD is placed first in the canonical decoder
access unit, including combined config/key input with prepended SEI.
Malformed/missing parameter sets, incompatible SPS/PPS references or multiple/
late delimiters fail explicitly. There is no encoder-only `avc.format` option,
browser-version branch, second decoder-format attempt or recreated stream.
Combined config+key units cache and decode their picture. Idle flush drains
buffered/reordered pictures and requires a new key afterward.

Decoder timestamps identify access-unit sequence plus decoder generation, not
the source PTS. Original transport timestamps remain `bigint`; subtraction and
range checks precede conversion of the separately retained decoder-local clock.
Equal PTS and B-picture timestamp backtracking therefore cannot merge owners.
Every deferred paint uses its retained geometry/owner guard, and every output
frame closes even when stale.

Actual prepared GitHub and VS Code copies are tested with window-one config,
combined key/config, equal PTS, delayed/reordered output, drop/geometry change,
queue exhaustion and close/reopen. Own-generated real baseline and High/two-B
H.264 fixtures were also decoded by Chrome through each prepared player, with
reference I420-plane comparisons. Those tests do not establish device, RGB
conversion, release artifact or full product parity.

Production legacy video remains unchanged. The installed opt-in host/runtime,
HTTP/WS and resource cleanup contracts are described in
[the protocol adapter](ailoha-protocol-adapter.md). Public SDK pins, native
artifact/source provenance and release/device evidence remain independent gates.
