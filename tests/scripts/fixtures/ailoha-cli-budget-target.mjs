import { writeFileSync } from "node:fs";

setTimeout(() => {
  writeFileSync(process.argv[2], "owned-synthetic-wire");
  process.stdout.write('{"ownedSyntheticWire":true}');
}, 1_000);
