/**
 * 打包「面板粘贴版」单文件 Worker。
 *
 * 用途：不方便用 wrangler / CI 的人，可以直接把产物整段贴进
 * Cloudflare Dashboard 的 Worker 在线编辑器（配合 VISITS KV 绑定即可跑）。
 *
 * 用法：node scripts/build-single.mjs
 * 产物：single-file/worker.js（自动生成，请勿手改）
 */

import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outfile = resolve(root, "single-file/worker.js");

const banner = `/*
 * cf-visit-gateway —— 单文件版（自动生成，请勿手动编辑）
 * 由 scripts/build-single.mjs 从 src/ 打包而来，重新生成：npm run build:single
 *
 * 部署（无需命令行）：
 *   1. Cloudflare Dashboard → Workers & Pages → 创建 Worker，粘贴本文件全部内容
 *   2. 左侧「存储和数据库」→ KV → 创建命名空间（如 cf-visit-gateway）
 *   3. 回到 Worker → 设置 → 绑定 → KV 命名空间，变量名必须填 VISITS
 *   4. 按需添加环境变量 TARGET_URL / SITE_TITLE / TZ_OFFSET / AUTO_REDIRECT
 *
 * 注意：单文件版只能使用 KV 后端（近似计数）。需要精确计数请用
 * wrangler 部署主项目（Durable Object 后端）。
 */`;

await build({
  entryPoints: [resolve(root, "src/index.js")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  banner: { js: banner },
  loader: { ".html": "text", ".jpg": "binary", ".png": "binary", ".ico": "binary" },
});

const { size } = await stat(outfile);
console.log(`single-file/worker.js 已生成 · ${(size / 1024).toFixed(1)} KB`);
