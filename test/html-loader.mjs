/**
 * 让 Node 能 import 静态资源（与 wrangler 的模块规则行为对齐），
 * 这样集成测试可以真实加载 src/index.js 而不需要任何构建步骤。
 *
 *   *.html        -> 文本模块（对应 wrangler 的 Text 规则）
 *   *.jpg/*.png   -> 二进制模块，默认导出 ArrayBuffer（对应 wrangler 的 Data 规则）
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BINARY = /\.(jpg|jpeg|png|webp|gif|ico)$/i;

export async function load(url, context, nextLoad) {
  if (url.endsWith(".html")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }

  if (BINARY.test(url)) {
    const buf = await readFile(fileURLToPath(url));
    // 与 Workers 的 Data 模块一致：默认导出 ArrayBuffer
    const source =
      `const b = Buffer.from(${JSON.stringify(buf.toString("base64"))}, "base64");\n` +
      `export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);\n`;
    return { format: "module", source, shortCircuit: true };
  }

  return nextLoad(url, context);
}
