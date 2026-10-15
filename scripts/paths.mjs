/**
 * 本地打印隐藏路由表 —— `npm run paths`
 *
 * 因为接口路径由 API_SECRET 派生且不对外暴露，运维本机需要知道路径才能 curl。
 * 本脚本在本地推导，不联网、不上报、不写入任何文件。
 *
 * 密钥来源优先级：环境变量 API_SECRET > .dev.vars（已 gitignore）
 *
 * 用法：
 *   npm run paths
 *   BASE_URL=https://你的域名 npm run paths
 */

import { readFileSync } from "node:fs";
import { DEFAULT_SECRET, derivePaths } from "../src/secret.js";

function loadDevVars() {
  try {
    const raw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const out = {};
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const devVars = loadDevVars();
const secret = process.env.API_SECRET || devVars.API_SECRET || "";
const adminToken = process.env.ADMIN_TOKEN || devVars.ADMIN_TOKEN || "";
const base = (process.env.BASE_URL || "https://<你的-worker-域名>").replace(/\/+$/, "");

if (!secret) {
  console.log("⚠️  未找到 API_SECRET（环境变量与 .dev.vars 都没有）。");
  console.log("    下面按公开默认盐推导：路径只有混淆强度，生产环境请务必配置真实密钥。\n");
}

const paths = await derivePaths(secret || DEFAULT_SECRET);

const rows = [
  ["页面 / 入口", "/", "GET", "浏览器打开"],
  ["跳转（可分享）", paths.action.g, "GET", "302 → 目标站，并计入跳转次数"],
  ["记录访问", paths.action.v, "POST", "需请求头 x-sig: <签名>（页面自动携带）"],
  ["读取统计", paths.action.s, "GET", "需请求头 x-sig"],
  ["记录跳转", paths.action.c, "POST", "需请求头 x-sig"],
  ["清零统计", paths.action.r, "POST", `需请求头 x-admin-token: ${adminToken ? "<ADMIN_TOKEN>" : "（未配置，接口关闭）"}`],
  ["运维自检", paths.action.h, "GET", "需请求头 x-admin-token"],
  ["徽章", paths.action.b, "GET", "需 ENABLE_BADGE=true"],
];

console.log(`前缀：${paths.prefix}${secret ? "" : "（公开默认盐）"}`);
console.log(`密钥来源：${process.env.API_SECRET ? "环境变量 API_SECRET" : devVars.API_SECRET ? ".dev.vars" : "无（默认盐）"}\n`);
console.log("路径".padEnd(20) + "方法".padEnd(8) + "说明");
for (const [name, path, method, note] of rows) {
  console.log(`${name.padEnd(18)}  ${path.padEnd(26)} ${method.padEnd(6)} ${note}`);
}

console.log(`\n可分享链接：${base}${paths.action.g}`);
console.log(`页面地址：  ${base}/`);
console.log("\n运维命令（把 <ADMIN_TOKEN> 换成真实令牌）：");
console.log(`  curl -s ${base}${paths.action.h} -H "x-admin-token: <ADMIN_TOKEN>"`);
console.log(`  curl -s -X POST ${base}${paths.action.r} -H "x-admin-token: <ADMIN_TOKEN>"`);
console.log(`\n本地开发自检（wrangler dev 默认端口）：`);
console.log(`  curl -s http://127.0.0.1:8787${paths.action.h} -H "x-admin-token: <ADMIN_TOKEN>"`);
