export async function runAilohaPlayerBrowserCheck(createPlayer, media = "baseline") {
  const prefix = media === "bframes" ? "/fixtures-bframes" : "/fixtures";
  const manifest = await (await fetch(`${prefix}/manifest.json`)).json();
  const packets = await Promise.all(manifest.units.map(async (unit) =>
    new Uint8Array(await (await fetch(`${prefix}/${unit.filename}`)).arrayBuffer())));
  const references = await Promise.all((manifest.referenceFrames ?? []).map(async (filename) =>
    createImageBitmap(await (await fetch(`${prefix}/${filename}`)).blob())));
  const frames = [];
  const clones = [];
  const errors = [];
  const sent = [];
  const canvas = document.createElement("canvas");
  const reference = document.createElement("canvas");
  canvas.width = reference.width = manifest.width;
  canvas.height = reference.height = manifest.height;
  document.body.append(canvas);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const referenceContext = reference.getContext("2d", { willReadFrequently: true });
  const player = createPlayer({
    context: { videoSessionId: "synthetic-video", ownerId: "synthetic-view-owner" },
    onGeometry() {},
    onError(error) { errors.push({ code: error.code, cause: error.cause?.code }); },
    present(frame, metadata) {
      context.drawImage(frame, 0, 0, manifest.width, manifest.height);
      const unit = manifest.units.find((entry) => entry.sequence === metadata.sequence);
      let maxChannelDifference = 0;
      let differingChannels = 0;
      if (references.length > 0) {
        referenceContext.drawImage(references[unit.pictureIndex], 0, 0);
        const actual = context.getImageData(0, 0, manifest.width, manifest.height).data;
        const expected = referenceContext.getImageData(0, 0, manifest.width, manifest.height).data;
        for (let index = 0; index < actual.length; index += 1) {
          const difference = Math.abs(actual[index] - expected[index]);
          maxChannelDifference = Math.max(maxChannelDifference, difference);
          if (difference > 3) differingChannels += 1;
        }
      }
      frames.push({
        sequence: metadata.sequence,
        pictureIndex: unit.pictureIndex,
        timestampMicroseconds: String(metadata.timestampMicroseconds),
        decoderTimestamp: frame.timestamp,
        decoderClockMicroseconds: metadata.decoderClockMicroseconds,
        geometryRevision: metadata.geometryRevision,
        logicalBounds: metadata.geometry.bounds,
        width: frame.displayWidth,
        height: frame.displayHeight,
        maxChannelDifference,
        differingChannels,
      });
      clones.push(frame.clone());
      return true;
    },
  });
  const connection = player.attach({
    protocol: "ailoha.video.v1",
    send(text) { sent.push(JSON.parse(text)); },
    close() {},
  });
  try {
    await connection.start();
    await connection.receive(JSON.stringify({
      type: "ready", videoSessionId: "synthetic-video", codec: "h264",
      geometryRevision: manifest.geometry[0].geometryRevision, resumeFromSequence: 0, maxInFlightFrames: 1,
    }));
    let revision = null;
    for (let index = 0; index < packets.length; index += 1) {
      const unit = manifest.units[index];
      if (unit.geometryRevision !== revision) {
        revision = unit.geometryRevision;
        const geometry = manifest.geometry.find((entry) => entry.geometryRevision === revision);
        await connection.receive(JSON.stringify({ type: "geometryChanged", ...geometry }));
      }
      if (!await connection.receive(packets[index])) throw new Error(`Real WebCodecs did not consume unit ${unit.sequence}.`);
      if (media === "baseline" && unit.kind !== "config") {
        const expectedPictures = unit.pictureIndex + 1;
        const deadline = performance.now() + 5000;
        while (frames.length < expectedPictures && performance.now() < deadline && errors.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (frames.length !== expectedPictures) throw new Error("Captured real decoder output did not arrive.");
      }
    }
    const deadline = performance.now() + 5000;
    while (frames.length < manifest.referenceI420.frames && performance.now() < deadline && errors.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const acknowledgements = sent.filter((message) => message.type === "ack").map((message) => message.sequence);
    const rawReference = new Uint8Array(await (await fetch(`${prefix}/reference.yuv`)).arrayBuffer());
    for (let index = 0; index < clones.length; index += 1) {
      const frame = clones[index];
      const bytes = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(bytes);
      const actual = new Uint8Array(manifest.referenceI420.frameBytes);
      const yBytes = manifest.width * manifest.height;
      const chromaWidth = manifest.width / 2;
      const chromaHeight = manifest.height / 2;
      const copyPlane = (plane, width, height, offset) => {
        for (let row = 0; row < height; row += 1) {
          actual.set(bytes.subarray(plane.offset + row * plane.stride,
            plane.offset + row * plane.stride + width), offset + row * width);
        }
      };
      copyPlane(layout[0], manifest.width, manifest.height, 0);
      if (frame.format === "I420") {
        copyPlane(layout[1], chromaWidth, chromaHeight, yBytes);
        copyPlane(layout[2], chromaWidth, chromaHeight, yBytes + yBytes / 4);
      } else if (frame.format === "NV12") {
        for (let row = 0; row < chromaHeight; row += 1) {
          for (let column = 0; column < chromaWidth; column += 1) {
            const source = layout[1].offset + row * layout[1].stride + column * 2;
            actual[yBytes + row * chromaWidth + column] = bytes[source];
            actual[yBytes + yBytes / 4 + row * chromaWidth + column] = bytes[source + 1];
          }
        }
      } else throw new Error(`Decoder returned an unsupported reference-comparison format ${frame.format}.`);
      const pictureIndex = frames[index].pictureIndex;
      const expected = rawReference.subarray(pictureIndex * actual.length, (pictureIndex + 1) * actual.length);
      frames[index].i420ByteDifferences = actual.reduce((count, byte, offset) => count + (byte !== expected[offset] ? 1 : 0), 0);
      frame.close();
    }
    const commonPassed = errors.length === 0 && frames.length === manifest.referenceI420.frames
      && JSON.stringify(acknowledgements) === "[0,1,2,3,4,5]"
      && frames.every((frame) => frame.width === 96 && frame.height === 64 && frame.i420ByteDifferences === 0)
      && frames[0].timestampMicroseconds === "9223372036854775808";
    const passed = commonPassed && (media === "baseline"
      ? frames[1].decoderClockMicroseconds - frames[0].decoderClockMicroseconds === 500000
        && frames[3].decoderClockMicroseconds - frames[2].decoderClockMicroseconds === 500000
        && frames[0].geometryRevision === 13 && frames[2].geometryRevision === 14
      : JSON.stringify(frames.map((frame) => frame.pictureIndex)) === "[0,1,2,3,4,5]"
        && frames.every((frame) => frame.geometryRevision === 21
          && frame.timestampMicroseconds === String(BigInt(manifest.timestampBase) + BigInt(frame.pictureIndex) * 500000n)));
    return { passed, media, acknowledgements, frames, errors };
  } finally {
    await player.dispose();
    for (const frame of clones) frame.close();
    for (const bitmap of references) bitmap.close();
  }
}
