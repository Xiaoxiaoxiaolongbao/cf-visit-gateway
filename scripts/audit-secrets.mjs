/**
 * 密钥泄露自检 —— `npm run audit`
 *
 * 目的：在推仓库 / 部署之前，机械地证明「任何 key 都不会出现在
 * 仓库文件、客户端可见产物、构建产物或配置文件里」。
 *
 * 四类检查：
 *   1. 已知密钥形态：私钥块、GitHub / Slack / OpenAI / AWS / Google / JWT 令牌。
 *   2. 显式密钥名：API_SECRET / ADMIN_TOKEN / CLOUDFLARE_* 等环境变量里
 *      当前真实值，逐个在全仓库文件中搜索（这是最有价值的一条：
 *      万一有人把 secret 贴进 README、代码或 .dev.vars 并提交，这里会拦下）。
 *   3. 客户端可见文件（src/page.html、single-file/worker.js）不得出现密钥变量名或密钥值。
 *   4. 卫生检查：wrangler.toml 不得硬编码密钥，.gitignore 必须覆盖机密文件，
 *      git 索引里不得存在机密文件。
 *
 * 用法：
 *   node scripts/audit-secrets.mjs
 *   VG_AUDIT_SECRETS="额外要搜的值1,额外要搜的值2" node scripts/audit-secrets.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", ".idea", ".vscode", "coverage"]);

/**
 * 这些文件本来就该装密钥，不参与内容扫描（否则必然误报）。
 * 对它们的保障是另外两条：.gitignore 必须覆盖、git 索引里不得存在。
 */
const SECRET_FILE_PATTERN = /^\.(dev\.vars|env)(\..+)?$/;
const SECRET_FILE_EXCEPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);
const isTemplateFile = (name) => /\.(example|sample|template)$/.test(name) || SECRET_FILE_EXCEPTIONS.has(name);

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".toml", ".yaml", ".yml",
  ".html", ".css", ".md", ".txt", ".sh", ".ps1", ".bat", ".example", "",
]);

/** 显式参与比对的环境变量名（避免误扫无关环境变量） */
const SECRET_ENV_NAMES = [
  "API_SECRET",
  "ADMIN_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "VG_AUDIT_SECRETS",
];

/** 真正会发给浏览器的文件：整份内容都必须干净 */
const CLIENT_FILES = ["src/page.html"];

/** 构建产物里内联的页面片段（模板字符串中的 <!DOCTYPE html> … </html>）同样必须干净 */
const EMBEDDED_PAGE_FILES = ["single-file/worker.js"];

const CLIENT_FORBIDDEN = ["API_SECRET", "ADMIN_TOKEN", "CLOUDFLARE_API_TOKEN", "SECRET_KEY", "x-admin-token"];

const PATTERNS = [
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI Key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack Token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "硬编码密钥赋值", re: /\b(?:API_SECRET|ADMIN_TOKEN|SECRET|apiKey|api_key)\s*[:=]\s*["'][^"'\s]{12,}["']/ },
];

const findings = [];
const report = (file, line, kind, detail) => findings.push({ file, line, kind, detail });

/** 递归收集仓库文件（跳过依赖与构建产物） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SECRET_FILE_PATTERN.test(entry.name) && !SECRET_FILE_EXCEPTIONS.has(entry.name)) continue;
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

function collectSecretValues() {
  const values = [];
  for (const name of SECRET_ENV_NAMES) {
    const raw = process.env[name];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (value.length >= 8) values.push({ name, value });
    }
  }
  return values;
}

/* ------------------------------------------------------------------ 执行 */

const files = walk(ROOT);
const secretValues = collectSecretValues();

/* 1 + 2：全仓库扫描密钥形态与真实密钥值 */
for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) report(rel, index + 1, name, line.trim().slice(0, 120));
    }
    for (const { name, value } of secretValues) {
      if (line.includes(value)) report(rel, index + 1, `环境变量 ${name} 的真实值`, line.trim().slice(0, 120));
    }
  });
}

/* 3：客户端可见内容不得出现密钥名 */
for (const rel of CLIENT_FILES) {
  let content;
  try {
    content = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  for (const needle of CLIENT_FORBIDDEN) {
    if (content.includes(needle)) report(rel, 0, "客户端文件泄露密钥变量名", needle);
  }
}

for (const rel of EMBEDDED_PAGE_FILES) {
  let content;
  try {
    content = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue; // 尚未生成（如未执行 build:single）时跳过
  }
  const start = content.indexOf("<!DOCTYPE html>");
  const end = content.lastIndexOf("</html>");
  const page = start >= 0 && end > start ? content.slice(start, end) : "";
  if (!page) report(rel, 0, "未能提取内联页面片段", "构建产物结构异常，请重新执行 build:single");
  for (const needle of CLIENT_FORBIDDEN) {
    if (page.includes(needle)) report(rel, 0, "构建产物内联的页面片段泄露密钥变量名", needle);
  }
}

/* 4a：wrangler.toml 不得硬编码密钥 */
try {
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  toml.split("\n").forEach((line, index) => {
    if (/^\s*(?:API_SECRET|ADMIN_TOKEN|CLOUDFLARE_API_TOKEN)\s*=\s*"[^"]+"/.test(line)) {
      report("wrangler.toml", index + 1, "配置文件硬编码密钥", line.trim().slice(0, 120));
    }
  });
} catch {
  /* 没有配置文件就跳过 */
}

/* 4b：.gitignore 必须覆盖机密文件 */
try {
  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  for (const required of [".dev.vars", ".env", "*.pem", "*.key"]) {
    if (!ignore.includes(required)) report(".gitignore", 0, "未忽略机密文件模式", required);
  }
} catch {
  report(".gitignore", 0, "缺少 .gitignore", "无法确认机密文件是否被忽略");
}

/* 4c：git 索引里不得出现机密文件 */
try {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const file of tracked) {
    const name = file.split("/").pop() || "";
    if (isTemplateFile(name)) continue; // 模板文件本就该被跟踪，且不含真实值
    if (SECRET_FILE_PATTERN.test(name) || /\.(pem|key|p12|pfx|jks)$/.test(file)) {
      report(file, 0, "机密文件已被 git 跟踪", "请从索引移除并加入 .gitignore");
    }
  }
} catch {
  /* 非 git 仓库时跳过 */
}

/* 4d：受跟踪文件不得带 UTF-8 BOM —— BOM 会污染 TOML 解析与提交信息，是典型的"隐形脏数据" */
try {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const file of tracked) {
    let head;
    try {
      head = readFileSync(join(ROOT, file)).subarray(0, 3);
    } catch {
      continue;
    }
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      report(file, 1, "文件带 UTF-8 BOM", "请保存为无 BOM 的 UTF-8");
    }
  }
} catch {
  /* 非 git 仓库时跳过 */
}

/* ------------------------------------------------------------------ 输出 */

console.log(`扫描文件：${files.length} 个`);
console.log(`比对密钥值：${secretValues.length} 个${secretValues.length ? `（${secretValues.map((s) => s.name).join(", ")}）` : "（无，可设 VG_AUDIT_SECRETS 补充）"}`);

if (findings.length === 0) {
  console.log("结果：未发现密钥泄露 ✅");
  process.exit(0);
}

console.log(`\n结果：发现 ${findings.length} 处疑似泄露 ❌\n`);
for (const { file, line, kind, detail } of findings) {
  console.log(`  ${file}${line ? `:${line}` : ""}  [${kind}]`);
  if (detail) console.log(`      ${detail}`);
}
process.exit(1);
