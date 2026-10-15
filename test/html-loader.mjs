/**
 * 让 Node 能 import '.html'（与 wrangler 的 Text 规则行为一致），
 * 这样集成测试可以真实加载 src/index.js 而不需要任何构建步骤。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".html")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
