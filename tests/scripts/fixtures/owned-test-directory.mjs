import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

export async function ownedTestDirectory(t, prefix) {
  const root = join(process.cwd(), ".build", "test-artifacts");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
