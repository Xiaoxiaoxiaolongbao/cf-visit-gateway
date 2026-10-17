/**
 * cf-visit-gateway —— Cloudflare Worker 入口
 *
 * 对外只暴露三个东西：
 *   GET  /                静态统计页（唯一公开入口）
 *   GET  /favicon.svg     站点图标
 *   GET  /<prefix>/g      302 跳转到目标站（prefix 由密钥派生，不可猜，可对外分享）
 *
 * 其余全部接口都藏在派生前缀之下，且需要「按时间窗轮换的 HMAC 签名」才可用：
 *   POST /<prefix>/v  记录访问      GET /<prefix>/s  读取统计
 *   POST /<prefix>/c  记录跳转      GET /<prefix>/b  徽章（需 ENABLE_BADGE=true）
 *   POST /<prefix>/r  令牌清零      GET /<prefix>/h  运维自检（需 ADMIN_TOKEN）
 *
 * 密钥纪律：
 *   - API_SECRET / ADMIN_TOKEN 只来自 env/secret，绝不写入响应体、响应头、页面或日志。
 *   - 页面里注入的是「签名」而不是「密钥」，签名按时间窗轮换、会失效。
 *   - 任何校验失败（路径不对、签名不对、来源不对、令牌不对、内部异常）都返回
 *     完全相同的空 404，不区分失败原因，避免变成探测预言机。
 */

import PAGE from "./page.html";
import NAIWA_BYTES from "../assets/naiwa.jpg";
import { createStore } from "./store.js";
import { emptyView } from "./stats.js";
import { DEFAULT_SECRET, derivePaths, mintToken, randomId, safeEqual, verifyToken } from "./secret.js";

export { Counter } from "./durable.js";

const VERSION = "1.0.0";

const COOKIE_NAME = "_vid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const UID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 客户端签名有效期（秒）。页面渲染时签发，校验时容忍前一个时间窗 */
const SIGN_WINDOW_S = 600;

const SPAN = 7;

/** 每 isolate 内存级节流：同一 IP 在 MIN_INTERVAL_MS 内的重复访问不再计 PV */
const recentHits = new Map();
const RECENT_MAX = 4096;

let warnedWeakSecret = false;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch {
      // 异常一律折叠成同一个 404：不泄露堆栈、不回显 env、不暴露内部结构
      return notFound();
    }
  },
};

async function route(request, env, ctx) {
  const cfg = config(env);
  const url = new URL(request.url);

  if (url.pathname === "/") return servePage(cfg);
  if (url.pathname === "/index.html") return servePage(cfg);
  if (url.pathname === "/favicon.svg") return favicon();
  if (url.pathname === "/naiwa.jpg") return avatarImage();

  const paths = await derivePaths(cfg.secret);
  const action = paths.byPath.get(url.pathname);
  if (!action) return notFound();

  const store = createStore(env);
  const params = { now: Date.now(), tz: cfg.tz, span: SPAN };

  switch (action) {
    case "v":
      return handleVisit(request, cfg, store, params);
    case "s":
      return (await isTrusted(request, cfg)) ? json(ordinalView(await readStats(store, params))) : notFound();
    case "c":
      return (await isTrusted(request, cfg)) ? handleClick(store, params) : notFound();
    case "g":
      return handleGo(cfg, store, params, ctx);
    case "r":
      return handleReset(request, cfg, store, params);
    case "h":
      return handleHealth(request, cfg, store, url, paths);
    case "b":
      return cfg.badge ? handleBadge(url, store, params) : notFound();
    default:
      return notFound();
  }
}

/* ------------------------------------------------------------------ 配置 */

function config(env) {
  const target = safeUrl(env?.TARGET_URL) ?? safeUrl("https://www.yzzx.org");
  const secret = text(env?.API_SECRET, "", 256) || DEFAULT_SECRET;

  if (secret === DEFAULT_SECRET && !warnedWeakSecret) {
    warnedWeakSecret = true;
    // 只进 Worker 日志（wrangler tail 可见），不进任何客户端可见输出
    console.warn(
      "[cf-visit-gateway] API_SECRET 未配置：接口路径与签名使用公开默认盐，仅具备混淆强度。" +
        "请执行 `npx wrangler secret put API_SECRET` 后再部署。",
    );
  }

  return {
    target,
    host: new URL(target).host,
    title: text(env?.SITE_TITLE, "本站访客统计", 60),
    tz: clampInt(env?.TZ_OFFSET, 8, -12, 14),
    auto: clampInt(env?.AUTO_REDIRECT, 0, 0, 300),
    minInterval: clampInt(env?.MIN_INTERVAL_MS, 1200, 0, 60000),
    adminToken: text(env?.ADMIN_TOKEN, "", 200),
    secret,
    hardened: secret !== DEFAULT_SECRET,
    badge: truthy(env?.ENABLE_BADGE),
  };
}

/** 只接受 http/https，避免把配置写成 javascript: 之类可注入协议的跳转目标 */
function safeUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function text(value, fallback, maxLength) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s.slice(0, maxLength) : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/* -------------------------------------------------------------- 页面渲染 */

async function servePage(cfg) {
  const paths = await derivePaths(cfg.secret);
  const nonce = randomId(16);
  const token = await mintToken(cfg.secret, Date.now(), SIGN_WINDOW_S);

  const payload = JSON.stringify({
    t: cfg.target, // 目标地址
    h: cfg.host,
    a: cfg.auto, // 自动跳转秒数
    g: paths.action.g, // 跳转路径
    v: paths.action.v, // 记访问路径
    s: paths.action.s, // 读统计路径
    k: token, // 时间窗签名，非密钥
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, "");

  const html = PAGE.replaceAll("{{TITLE}}", escapeHtml(cfg.title))
    .replaceAll("{{HOST}}", escapeHtml(cfg.host))
    .replaceAll("{{JUMP}}", escapeHtml(paths.action.g))
    .replaceAll("{{NONCE}}", nonce)
    .replaceAll("{{CONFIG_JSON}}", payload);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 页面携带会过期的签名，禁止任何中间层缓存
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

/* ---------------------------------------------------------------- 访问记录 */

async function handleVisit(request, cfg, store, params) {
  if (!(await isTrusted(request, cfg))) return notFound();

  const { uid, fresh } = ensureUid(request);
  const uidHash = await hashUid(uid);
  const throttled = shouldThrottle(clientIp(request), params.now, cfg.minInterval);

  const view =
    store.mode === "none"
      ? emptyView(params)
      : throttled
        ? await store.stats({ ...params, uidHash })
        : await store.visit({ ...params, uidHash });

  const headers = new Headers({ "cache-control": "no-store" });
  if (fresh) headers.append("set-cookie", uidCookie(uid));

  return json({ ...ordinalView(view), counted: store.mode !== "none" && !throttled, isNewVisitor: view.isNewVisitor }, 200, headers);
}

/**
 * 对外只下发「位次」相关字段（uv / first / configured）。
 * 总访问、今日、跳转次数、每日明细一律不下发给浏览器——否则在 devtools 里就能读到。
 * 运维要看全量请用 /<prefix>/h（需 ADMIN_TOKEN）。
 */
function ordinalView(view) {
  return { configured: view.configured, uv: view.uv, first: view.first };
}

async function handleClick(store, params) {
  if (store.mode === "none") return json(emptyView(params));
  return json(await store.click(params));
}

async function readStats(store, params) {
  return store.mode === "none" ? emptyView(params) : store.stats(params);
}

/* ------------------------------------------------------------------ 跳转 */

/**
 * 跳转端点只需要「不可猜的前缀」即可访问，不要求签名：
 * 这样分享出去的链接、禁 JS 的浏览器、爬虫都能正常跳转，同时路径本身不会出现在任何枚举字典里。
 */
async function handleGo(cfg, store, params, ctx) {
  if (store.mode !== "none") {
    const task = store.click(params).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
  return new Response(null, {
    status: 302,
    headers: { location: cfg.target, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/* ------------------------------------------------------- 运维：清零 / 自检 */

async function handleReset(request, cfg, store, params) {
  if (!cfg.adminToken) return notFound();
  if (request.method !== "POST") return notFound();
  if (!safeEqual(adminTokenOf(request), cfg.adminToken)) return notFound();

  const view = await store.reset(params);
  return json({ ok: true, ...view });
}

async function handleHealth(request, cfg, store, url, paths) {
  if (!cfg.adminToken) return notFound();
  if (!safeEqual(adminTokenOf(request), cfg.adminToken)) return notFound();

  const view = await readStats(store, { now: Date.now(), tz: cfg.tz, span: SPAN });
  return json({
    ok: true,
    version: VERSION,
    mode: store.mode,
    hardened: cfg.hardened,
    badge: cfg.badge,
    resetEnabled: true,
    target: cfg.target,
    tz: cfg.tz,
    jump: `${url.origin}${paths.action.g}`,
    stats: { configured: view.configured, total: view.total, uv: view.uv, clicks: view.clicks, today: view.today },
  });
}

/* ------------------------------------------------------------------ 徽章 */

const METRICS = {
  uv: { key: "uv", label: "visitors" },
  total: { key: "total", label: "visits" },
  today: { key: "today", label: "today" },
  clicks: { key: "clicks", label: "clicks" },
};

async function handleBadge(url, store, params) {
  const metric = METRICS[url.searchParams.get("metric") || "uv"] || METRICS.uv;
  const custom = url.searchParams.get("label");
  const label = custom && /^[\w\u4e00-\u9fa5 .-]{1,20}$/.test(custom) ? custom : metric.label;

  const view = await readStats(store, params);
  const value = view.configured ? formatNumber(view[metric.key]) : "n/a";

  return new Response(badgeSvg(label, value), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}

function badgeSvg(label, value) {
  const labelWidth = textWidth(label) + 12;
  const valueWidth = textWidth(value) + 12;
  const width = labelWidth + valueWidth;
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-opacity=".12"/></linearGradient>
  <mask id="m"><rect width="${width}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#m)">
    <rect width="${labelWidth}" height="20" fill="#3b3f4d"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#4f46e5"/>
    <rect width="${width}" height="20" fill="url(#g)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelX}" y="14">${escapeXml(label)}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${valueX}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

/** shields 同款粗估：ASCII 约 6.2px/字符，全角约 11px/字符 */
function textWidth(s) {
  let width = 0;
  for (const ch of String(s)) width += ch.codePointAt(0) > 255 ? 11 : 6.2;
  return Math.round(width);
}

/* ------------------------------------------------------------- 信任校验 */

/** 签名有效 + 同源（浏览器跨站请求带 Origin，直接拒掉） */
async function isTrusted(request, cfg) {
  if (!sameOrigin(request)) return false;
  return verifyToken(cfg.secret, request.headers.get("x-sig") || "", Date.now(), SIGN_WINDOW_S);
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // 非浏览器客户端没有 Origin，仍必须过签名
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function adminTokenOf(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return request.headers.get("x-admin-token") || (match ? match[1].trim() : "");
}

/* ------------------------------------------------------------- 访客标识 */

function ensureUid(request) {
  const existing = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (existing && UID_PATTERN.test(existing)) return { uid: existing, fresh: false };
  return { uid: randomId(16), fresh: true };
}

function uidCookie(uid) {
  return [
    `${COOKIE_NAME}=${uid}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** 只把访客标识的哈希写进存储，原文只留在用户自己的 Cookie 里 */
async function hashUid(uid) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* --------------------------------------------------------------- 工具函数 */

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

function shouldThrottle(ip, now, minInterval) {
  if (!minInterval) return false;
  if (recentHits.size > RECENT_MAX) recentHits.clear();
  const previous = recentHits.get(ip);
  recentHits.set(ip, now);
  return typeof previous === "number" && now - previous < minInterval;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/** 唯一的失败响应：无 body、无类型、无特征，所有失败路径逐字节相同 */
function notFound() {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(extra instanceof Headers ? extra.entries() : Object.entries(extra)),
    },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(s) {
  return escapeHtml(s);
}

/** 顶部圆形头像：真实奶蛙素材，按原字节提供（浏览器可缓存 1 天） */
function avatarImage() {
  const bytes = NAIWA_BYTES instanceof ArrayBuffer ? new Uint8Array(NAIWA_BYTES) : NAIWA_BYTES;
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

function favicon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#0b1020"/><circle cx="32" cy="32" r="17" fill="none" stroke="url(#a)" stroke-width="4"/><circle cx="32" cy="32" r="6" fill="url(#a)"/></svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
