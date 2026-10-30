import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
export function productModule(relative) {
  return pathToFileURL(join(process.env.AILOHA_TEST_PRODUCT_ROOT ?? repository, relative)).href;
}
