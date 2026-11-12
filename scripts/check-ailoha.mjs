import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const directory of ["lib/ailoha", "web"]) {
  for (const file of readdirSync(join(root, directory))) {
    if (directory === "web" && !file.startsWith("ailoha-")) continue;
    if (!/\.(mjs|js)$/.test(file)) continue;
    execFileSync(process.execPath, ["--check", join(root, directory, file)], { stdio: "inherit" });
  }
}
