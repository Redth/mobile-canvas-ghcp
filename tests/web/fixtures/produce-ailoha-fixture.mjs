import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAilohaVideoFrame } from "../../../web/ailoha-video-protocol.js";

const source = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const baseline = manifest.source === "Locally generated FFmpeg testsrc2; no device or third-party media.";
const bframes = manifest.source === "Locally generated FFmpeg testsrc2, H.264 High with two B-frames; no third-party or device media.";
const output = join(dirname(fileURLToPath(import.meta.url)), bframes ? "ailoha-bframes" : "ailoha-baseline");
if (manifest.schema !== "mobile-canvas.synthetic-video-fixture/v1"
  || (!baseline && !bframes)
  || manifest.units.length !== 6
  || (baseline && manifest.referenceFrames.length !== 4)
  || (bframes && manifest.expectedDecodedPictureIndices.length !== 6)) {
  throw new Error("Only the verified, device-free media fixtures may be retained.");
}
mkdirSync(output, { recursive: true });
const hashes = {};
for (const unit of manifest.units) {
  if (!/^[0-5][0-5]-(config|config-key|key|delta)\.alhv$/.test(unit.filename)) throw new Error("Invalid fixture filename.");
  const bytes = readFileSync(join(source, unit.filename));
  const parsed = parseAilohaVideoFrame(bytes);
  if (parsed.sequence !== unit.sequence || parsed.geometryRevision !== unit.geometryRevision
    || String(parsed.timestampMicroseconds) !== unit.timestampMicroseconds
    || parsed.isCodecConfig !== unit.isCodecConfig || parsed.isKeyFrame !== unit.isKeyFrame
    || parsed.payload.byteLength !== unit.payloadBytes) throw new Error("Fixture packet does not match its evidence.");
  writeFileSync(join(output, unit.filename), bytes, { flag: "wx" });
  hashes[unit.filename] = createHash("sha256").update(bytes).digest("hex");
}
for (const filename of manifest.referenceFrames ?? []) {
  if (!/^reference-[1-4]\.png$/.test(filename)) throw new Error("Invalid reference filename.");
  const bytes = readFileSync(join(source, filename));
  if (bytes.length > 1024 * 1024) throw new Error("Fixture reference exceeds its bound.");
  writeFileSync(join(output, filename), bytes, { flag: "wx" });
  hashes[filename] = createHash("sha256").update(bytes).digest("hex");
}
const yuv = readFileSync(join(source, "reference.yuv"));
const frameBytes = manifest.width * manifest.height * 3 / 2;
const frames = baseline ? 4 : 6;
if (yuv.length !== frameBytes * frames) throw new Error("I420 reference has an unexpected frame count.");
writeFileSync(join(output, "reference.yuv"), yuv, { flag: "wx" });
hashes["reference.yuv"] = createHash("sha256").update(yuv).digest("hex");
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  ...manifest,
  referenceI420: { filename: "reference.yuv", frameBytes, frames },
  sha256: hashes,
}, null, 2)}\n`, { flag: "wx" });
