/*
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
 */
var __toBinary = /* @__PURE__ */ (() => {
  var table = new Uint8Array(128);
  for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  return (base64) => {
    var n = base64.length, bytes = new Uint8Array((n - (base64[n - 1] == "=") - (base64[n - 2] == "=")) * 3 / 4 | 0);
    for (var i2 = 0, j = 0; i2 < n; ) {
      var c0 = table[base64.charCodeAt(i2++)], c1 = table[base64.charCodeAt(i2++)];
      var c2 = table[base64.charCodeAt(i2++)], c3 = table[base64.charCodeAt(i2++)];
      bytes[j++] = c0 << 2 | c1 >> 4;
      bytes[j++] = c1 << 4 | c2 >> 2;
      bytes[j++] = c2 << 6 | c3;
    }
    return bytes;
  };
})();

// src/page.html
var page_default = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>{{TITLE}}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style nonce="{{NONCE}}">
  :root {
    --paper: #f5f5f7;
    --ink: #8a8a8f;
    --ink-soft: #63636a;
    --hair: rgba(255, 255, 255, .085);
    --hair-strong: rgba(255, 255, 255, .16);
    --black: #050506;
    --ease: cubic-bezier(.16, 1, .3, 1);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  ::selection { background: rgba(245, 245, 247, .18); color: #fff; }

  body {
    margin: 0; min-height: 100svh; background: var(--black); color: var(--paper);
    display: flex; align-items: center; justify-content: center;
    padding: 40px 24px 36px; overflow-x: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
                 "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 16px; line-height: 1.5; -webkit-font-smoothing: antialiased;
    -webkit-tap-highlight-color: transparent; text-rendering: optimizeLegibility;
  }

  /* 单一侧光：左上偏心，避免对称的「打光感」；用极慢的漂移代替循环动画的廉价感 */
  body::before {
    content: ""; position: fixed; left: 50%; top: -18vh; width: 120vw; height: 96vh;
    transform: translateX(-50%); pointer-events: none; z-index: 0;
    background:
      radial-gradient(38% 34% at 42% 12%, rgba(255, 255, 255, .13), transparent 68%),
      radial-gradient(60% 42% at 56% 0%, rgba(190, 205, 255, .07), transparent 72%);
    animation: drift 26s ease-in-out infinite alternate;
  }
  @keyframes drift {
    from { transform: translateX(-51%) translateY(-1.5%); }
    to { transform: translateX(-49%) translateY(1.5%); }
  }

  /* 纸感颗粒：消除大面积渐变的色带，让黑看起来有材质而不是纯色块 */
  body::after {
    content: ""; position: fixed; inset: 0; z-index: 3; pointer-events: none; opacity: .032;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  main { position: relative; z-index: 1; width: min(620px, 100%); text-align: center; }

  /* 顶部分隔细线：两端渐隐，像印刷品的裁切边 */
  .seam {
    height: 1px; width: 100%; margin: 0 0 34px;
    background: linear-gradient(90deg, transparent, var(--hair-strong) 22%, var(--hair-strong) 78%, transparent);
    animation: reveal 1.1s var(--ease) both;
  }

  .kicker {
    margin: 0 0 30px; font-family: var(--mono); font-size: 10.5px; font-weight: 400;
    letter-spacing: .22em; text-transform: uppercase; color: var(--ink-soft);
    animation: reveal 1.1s .06s var(--ease) both;
  }

  /* 展陈主体：细描边圆框 + 一圈极窄的镜面高光弧 */
  .exhibit { position: relative; width: min(300px, 56vw, 34vh); margin: 0 auto; animation: reveal 1.3s .1s var(--ease) both; }
  .frame {
    position: relative; aspect-ratio: 1 / 1; border-radius: 50%; overflow: hidden;
    box-shadow: 0 0 0 1px var(--hair-strong);
  }
  .frame .naiwa-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; }
  .frame .naiwa-fallback { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; }
  /* 镜面高光：只占左上约 1/4 的一层柔光，不做全屏 bloom */
  .frame::after {
    content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none; mix-blend-mode: screen;
    background: radial-gradient(58% 46% at 26% 12%, rgba(255, 255, 255, .20), transparent 62%);
  }
  /* 22 秒一轮、5% 透明度的掠过光，慢到几乎察觉不到 */
  .frame::before {
    content: ""; position: absolute; inset: -35% -130%; z-index: 3; pointer-events: none;
    background: linear-gradient(104deg, transparent 44%, rgba(255, 255, 255, .05) 50%, transparent 56%);
    animation: pass 22s cubic-bezier(.4, 0, .2, 1) infinite;
  }
  @keyframes pass {
    0%, 34% { transform: translateX(-52%); }
    62%, 100% { transform: translateX(52%); }
  }

  /* 展签：把吐槽排成博物馆标签的样子，这是本页唯一的玩笑装置 */
  .plate {
    margin: 22px 0 0; padding: 0 0 20px;
    font-family: var(--mono); font-size: 10.5px; line-height: 1.9;
    letter-spacing: .1em; color: var(--ink-soft); text-transform: none;
  }
  .plate b { display: block; font-weight: 500; color: var(--ink); letter-spacing: .12em; }
  .plate span { display: block; }

  .headline {
    margin: 34px 0 0; font-size: 15px; font-weight: 400; letter-spacing: .02em; color: var(--ink);
    animation: reveal 1.1s .2s var(--ease) both;
  }
  .headline .num {
    display: block; margin: 6px 0 2px;
    font-size: clamp(72px, 14vw, 108px); font-weight: 500; letter-spacing: -.055em;
    line-height: 1; color: var(--paper); font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1;
  }
  .serial {
    margin: 18px 0 0; font-family: var(--mono); font-size: 10px; letter-spacing: .24em;
    text-transform: uppercase; color: var(--ink-soft);
    animation: reveal 1.1s .26s var(--ease) both;
  }
  .serial::before, .serial::after { content: "—"; margin: 0 10px; color: var(--hair-strong); }

  .cta-wrap { margin: 38px 0 0; animation: reveal 1.1s .32s var(--ease) both; }
  .cta {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 13px 28px; border-radius: 980px; border: 0;
    background: var(--paper); color: #0a0a0c; text-decoration: none;
    font-size: 15px; font-weight: 500; letter-spacing: .01em;
    transition: background-color .25s ease, transform .25s var(--ease);
  }
  .cta:hover { background: #ffffff; }
  .cta:active { transform: scale(.988); }
  .cta:focus-visible { outline: 2px solid var(--hair-strong); outline-offset: 4px; }
  .cta svg { width: 13px; height: 13px; }
  .dest {
    margin: 16px 0 0; font-family: var(--mono); font-size: 10px; letter-spacing: .2em;
    text-transform: uppercase; color: var(--ink-soft);
  }

  @keyframes reveal {
    from { opacity: 0; transform: translateY(10px); filter: blur(5px); }
    to { opacity: 1; transform: none; filter: none; }
  }

  /* 矮屏：压缩纵向节奏，保证主按钮始终留在首屏 */
  @media (max-height: 880px) {
    .seam { margin-bottom: 22px; }
    .kicker { margin-bottom: 18px; }
    .exhibit { width: min(250px, 46vw, 29vh); }
    .plate { margin-top: 16px; padding-bottom: 12px; font-size: 10px; line-height: 1.7; }
    .plate .detail { display: none; }
    .headline { margin-top: 22px; }
    .headline .num { font-size: clamp(54px, 9.4vh, 86px); margin: 4px 0 0; }
    .serial { display: none; }
    .cta-wrap { margin-top: 26px; }
  }
  @media (max-width: 520px) {
    body { padding: 32px 20px 28px; }
    .seam { margin-bottom: 26px; }
    .kicker { margin-bottom: 24px; letter-spacing: .16em; }
    .exhibit { width: min(232px, 60vw, 30vh); }
    .plate { margin-top: 18px; padding-bottom: 16px; }
    .headline { margin-top: 26px; }
    .cta-wrap { margin-top: 30px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .001ms !important;
      animation-delay: 0ms !important;
      transition-duration: .001ms !important;
    }
  }
</style>
</head>
<body>
<main>
  <div class="seam"></div>
  <p class="kicker">Naiwa Middle School &middot; Jiangsu &middot; Est. 2026</p>

  <!-- 展陈主体：真实奶蛙素材（社区素材仓库 Nailong-Studio/wallpaper 的 4K-抱头震惊-02，见 README）
       下层内联 SVG 仅作加载失败兜底，不参与正常显示 -->
  <div class="exhibit">
    <div class="frame">
      <img class="naiwa-img" src="/naiwa.jpg" alt="奶蛙" width="512" height="512" decoding="async" fetchpriority="high">
      <svg class="naiwa-fallback" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id="naiwaBg" cx="50%" cy="34%" r="78%">
            <stop offset="0" stop-color="#1b2540"/>
            <stop offset="100%" stop-color="#0a1020"/>
          </radialGradient>
          <radialGradient id="naiwaSkin" cx="38%" cy="26%" r="86%">
            <stop offset="0" stop-color="#e6f8ec"/>
            <stop offset="46%" stop-color="#a9e7bd"/>
            <stop offset="100%" stop-color="#57b881"/>
          </radialGradient>
        </defs>
        <circle cx="100" cy="100" r="100" fill="url(#naiwaBg)"/>
        <circle cx="78" cy="52" r="17" fill="#ffffff" opacity=".93"/>
        <circle cx="101" cy="41" r="23" fill="#ffffff"/>
        <circle cx="125" cy="53" r="15" fill="#ffffff" opacity=".90"/>
        <ellipse cx="100" cy="120" rx="61" ry="53" fill="url(#naiwaSkin)"/>
        <circle cx="64" cy="78" r="26" fill="#f7fffb"/>
        <circle cx="136" cy="78" r="26" fill="#f7fffb"/>
        <circle cx="66" cy="80" r="12" fill="#17281f"/>
        <circle cx="134" cy="80" r="12" fill="#17281f"/>
        <circle cx="61" cy="74" r="4.4" fill="#ffffff"/>
        <circle cx="129" cy="74" r="4.4" fill="#ffffff"/>
        <circle cx="90" cy="124" r="3.2" fill="#3c6b52" opacity=".65"/>
        <circle cx="110" cy="124" r="3.2" fill="#3c6b52" opacity=".65"/>
        <path d="M76 142 q24 22 48 0" fill="none" stroke="#2f5d43" stroke-width="5" stroke-linecap="round"/>
        <ellipse cx="46" cy="146" rx="14" ry="9" fill="#ff9db1" opacity=".45"/>
        <ellipse cx="154" cy="146" rx="14" ry="9" fill="#ff9db1" opacity=".45"/>
      </svg>
    </div>
  </div>

  <!-- 展签：本页唯一的玩笑装置，写成博物馆标签的格式 -->
  <p class="plate">
    <b>奶蛙 &middot; 叉腰指点 &middot; № 03</b>
    <span class="detail">态度：胸有成竹 / 材质：奶 / 来源：民间</span>
    <span class="detail">状态：常设展 &middot; 无需门票</span>
  </p>

  <p class="headline">
    你是第
    <span class="num" id="uv" aria-live="polite">&ndash;</span>
    位来到该网站的访客
  </p>

  <p class="serial" id="serial">Visitor Record</p>

  <div class="cta-wrap">
    <a class="cta" id="cta" href="{{JUMP}}"><span id="cta-label">前往扬州中学</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
    </a>
    <p class="dest">{{HOST}}</p>
  </div>
</main>

<script id="cfg" type="application/json" nonce="{{NONCE}}">{{CONFIG_JSON}}<\/script>
<script nonce="{{NONCE}}">
  (function () {
    "use strict";

    var cfg = {};
    try { cfg = JSON.parse(document.getElementById("cfg").textContent || "{}"); } catch (err) { cfg = {}; }

    var byId = function (id) { return document.getElementById(id); };
    var nf = new Intl.NumberFormat("en-US");
    var countUpTimers = new WeakMap();

    function countUp(el, target) {
      var from = Number(el.dataset.value || 0);
      var start = performance.now();
      var duration = 1000;
      var previous = countUpTimers.get(el);
      if (previous) cancelAnimationFrame(previous);
      el.dataset.value = String(target);
      if (from === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.textContent = nf.format(target);
        return;
      }
      (function step(now) {
        var p = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - p, 5);
        el.textContent = nf.format(Math.round(from + (target - from) * eased));
        if (p < 1) countUpTimers.set(el, requestAnimationFrame(step));
      })(start);
    }

    /* 状态行已移除：异常只静默写进等宽小字那一行，正常时保持 Visitor Record */
    function setNote(message) {
      var el = byId("serial");
      if (el) el.textContent = message;
    }

    function render(view) {
      if (view.configured !== false) {
        countUp(byId("uv"), view.uv || 0);
        setNote("Visitor Record");
      } else {
        setNote("不可用");
      }
    }

    function request(path, method) {
      return fetch(path, {
        method: method || "POST",
        headers: cfg.k ? { "x-sig": cfg.k } : {},
        body: method === "GET" ? undefined : "{}",
        credentials: "same-origin",
        cache: "no-store"
      });
    }

    function scheduleAutoRedirect() {
      var seconds = Number(cfg.a || 0);
      if (!seconds) return;
      var cta = byId("cta");
      cta.addEventListener("click", function () { seconds = 0; }, { once: true });
      var timer = setInterval(function () {
        seconds -= 1;
        if (seconds <= 0) {
          clearInterval(timer);
          location.replace(cta.getAttribute("href"));
          return;
        }
        var label = byId("cta-label");
        if (label) label.textContent = seconds + " 秒后前往";
      }, 1000);
    }

    function boot() {
      request(cfg.v, "POST")
        .then(function (res) {
          if (res.ok) return res.json();
          return request(cfg.s, "GET").then(function (fallback) { return fallback.ok ? fallback.json() : null; });
        })
        .then(function (view) {
          if (view) render(view);
          else setNote("读取失败");
          scheduleAutoRedirect();
        })
        .catch(function () {
          setNote("读取失败");
        });
    }

    boot();
  })();
<\/script>
</body>
</html>
`;

// assets/naiwa.jpg
var naiwa_default = __toBinary("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");

// src/stats.js
var STATS_VERSION = 1;
var MAX_DAYS = 14;
var UV_WINDOW_MS = 12 * 60 * 60 * 1e3;
var MAX_SEEN = 2e4;
var DAY_MS = 864e5;
function dayKey(ts, tzOffsetHours = 8) {
  const shifted = ts + tzOffsetHours * 36e5;
  return new Date(shifted).toISOString().slice(0, 10);
}
function createStats(now = Date.now()) {
  return {
    v: STATS_VERSION,
    first: now,
    last: now,
    total: 0,
    uv: 0,
    clicks: 0,
    days: {},
    seen: {}
  };
}
function normalize(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return createStats(now);
  const days = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [k, v] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))) {
        days[k] = Math.max(0, Math.trunc(Number(v)));
      }
    }
  }
  const seen = {};
  if (raw.seen && typeof raw.seen === "object") {
    for (const [k, v] of Object.entries(raw.seen)) {
      if (typeof k === "string" && k.length <= 64 && Number.isFinite(Number(v))) {
        seen[k] = Number(v);
      }
    }
  }
  const nowSafe = Number.isFinite(now) ? now : Date.now();
  return {
    v: STATS_VERSION,
    first: Number.isFinite(Number(raw.first)) ? Number(raw.first) : nowSafe,
    last: Number.isFinite(Number(raw.last)) ? Number(raw.last) : nowSafe,
    total: Math.max(0, Math.trunc(Number(raw.total) || 0)),
    uv: Math.max(0, Math.trunc(Number(raw.uv) || 0)),
    clicks: Math.max(0, Math.trunc(Number(raw.clicks) || 0)),
    days,
    seen
  };
}
function pruneSeen(stats, now) {
  const cutoff = now - UV_WINDOW_MS;
  for (const [k, ts] of Object.entries(stats.seen)) {
    if (!(ts > cutoff)) delete stats.seen[k];
  }
  const seenKeys = Object.keys(stats.seen);
  if (seenKeys.length > MAX_SEEN) {
    seenKeys.sort((a, b) => stats.seen[a] - stats.seen[b]).slice(0, seenKeys.length - MAX_SEEN).forEach((k) => delete stats.seen[k]);
  }
}
function trimDays(stats) {
  const keys = Object.keys(stats.days).sort();
  if (keys.length > MAX_DAYS) {
    for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete stats.days[k];
  }
}
function recordVisit(stats, { uidHash, now, tz = 8 }) {
  pruneSeen(stats, now);
  const day = dayKey(now, tz);
  stats.total += 1;
  stats.days[day] = (stats.days[day] || 0) + 1;
  stats.last = now;
  if (Number.isFinite(stats.first) && stats.first > now) stats.first = now;
  const isNewVisitor = Boolean(uidHash) && !stats.seen[uidHash];
  if (isNewVisitor) stats.uv += 1;
  if (uidHash) stats.seen[uidHash] = now;
  trimDays(stats);
  return { isNewVisitor };
}
function recordClick(stats, { now }) {
  stats.clicks += 1;
  stats.last = now;
  return {};
}
function viewStats(stats, { now, tz = 8, span = 7 }) {
  const todayKey = dayKey(now, tz);
  const series = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = dayKey(now - i * DAY_MS, tz);
    series.push({ d, pv: stats.days[d] || 0 });
  }
  return {
    configured: true,
    total: stats.total,
    uv: stats.uv,
    clicks: stats.clicks,
    today: stats.days[todayKey] || 0,
    todayKey,
    first: Number.isFinite(stats.first) ? stats.first : null,
    last: Number.isFinite(stats.last) ? stats.last : null,
    series
  };
}
function emptyView({ now = Date.now(), tz = 8, span = 7 } = {}) {
  return { ...viewStats(createStats(now), { now, tz, span }), configured: false };
}

// src/store.js
var KV_KEY = "stats";
var SINGLETON = "global";
function createStore(env) {
  if (env?.COUNTER && typeof env.COUNTER.get === "function") return durableStore(env);
  if (env?.VISITS && typeof env.VISITS.get === "function") return kvStore(env);
  return noneStore();
}
function durableStore(env) {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(SINGLETON));
  const call = async (path, params) => {
    const url = new URL(`https://counter.internal${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await stub.fetch(url.toString());
    if (!res.ok) throw new Error(`counter ${path} failed: ${res.status}`);
    return res.json();
  };
  return {
    mode: "durable",
    visit: (p) => call("/visit", p),
    click: (p) => call("/click", p),
    stats: (p) => call("/stats", p),
    reset: (p) => call("/reset", p)
  };
}
function kvStore(env) {
  const kv = env.VISITS;
  const load = async (now) => {
    let raw = null;
    try {
      raw = await kv.get(KV_KEY, "json");
    } catch {
      raw = null;
    }
    return normalize(raw, now);
  };
  return {
    mode: "kv",
    async visit(p) {
      const stats = await load(p.now);
      const { isNewVisitor } = recordVisit(stats, p);
      await kv.put(KV_KEY, JSON.stringify(stats));
      return { ...viewStats(stats, p), isNewVisitor };
    },
    async click(p) {
      const stats = await load(p.now);
      recordClick(stats, p);
      await kv.put(KV_KEY, JSON.stringify(stats));
      return viewStats(stats, p);
    },
    async stats(p) {
      return viewStats(await load(p.now), p);
    },
    async reset(p) {
      const stats = createStats(p.now);
      await kv.put(KV_KEY, JSON.stringify(stats));
      return viewStats(stats, p);
    }
  };
}
function noneStore() {
  return {
    mode: "none",
    visit: async (p) => emptyView(p),
    click: async (p) => emptyView(p),
    stats: async (p) => emptyView(p),
    reset: async (p) => emptyView(p)
  };
}

// src/secret.js
var encoder = new TextEncoder();
var DEFAULT_SECRET = "cf-visit-gateway:insecure-default-salt";
var PATH_SALT = "cf-visit-gateway:paths:v1";
var PREFIX_BYTES = 8;
var TOKEN_BYTES = 16;
var keyCache = /* @__PURE__ */ new Map();
var pathCache = /* @__PURE__ */ new Map();
var CACHE_LIMIT = 16;
function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}
function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    cacheSet(keyCache, secret, key);
  }
  return key;
}
function toHex(buffer, bytes) {
  return [...new Uint8Array(buffer).slice(0, bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, message, bytes) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return toHex(signature, bytes);
}
function derivePaths(secret) {
  const cached = pathCache.get(secret);
  if (cached) return cached;
  const pending = hmacHex(secret, PATH_SALT, PREFIX_BYTES).then((prefix) => {
    const base = `/${prefix}`;
    const action = {
      v: `${base}/v`,
      // 记录访问
      s: `${base}/s`,
      // 读取统计
      c: `${base}/c`,
      // 记录跳转（AJAX 场景）
      g: `${base}/g`,
      // 302 跳转（可分享）
      r: `${base}/r`,
      // 令牌清零
      h: `${base}/h`,
      // 运维自检（需令牌）
      b: `${base}/b`
      // 徽章（需显式开启）
    };
    return { prefix, action, byPath: new Map(Object.entries(action).map(([name, path]) => [path, name])) };
  });
  return cacheSet(pathCache, secret, pending);
}
function bucketOf(now, windowSeconds) {
  return Math.floor(now / (windowSeconds * 1e3));
}
function mintToken(secret, now, windowSeconds) {
  return hmacHex(secret, `client:${bucketOf(now, windowSeconds)}`, TOKEN_BYTES);
}
async function verifyToken(secret, token, now, windowSeconds) {
  if (typeof token !== "string" || token.length !== TOKEN_BYTES * 2) return false;
  const bucket = bucketOf(now, windowSeconds);
  const candidates = await Promise.all([
    hmacHex(secret, `client:${bucket}`, TOKEN_BYTES),
    hmacHex(secret, `client:${bucket - 1}`, TOKEN_BYTES)
  ]);
  return candidates.some((expected) => safeEqual(token, expected));
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function randomId(bytes = 16) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// src/durable.js
var STORAGE_KEY = "stats";
var DEFAULT_TZ = 8;
var DEFAULT_SPAN = 7;
function intOr(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
var Counter = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.stats = null;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.stats = normalize(await state.storage.get(STORAGE_KEY), Date.now());
    });
  }
  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const now = Date.now();
    const ctx = {
      now,
      tz: intOr(url.searchParams.get("tz"), DEFAULT_TZ),
      span: intOr(url.searchParams.get("span"), DEFAULT_SPAN),
      uidHash: url.searchParams.get("uidHash") || ""
    };
    switch (url.pathname) {
      case "/visit": {
        const { isNewVisitor } = recordVisit(this.stats, ctx);
        await this.#persist();
        return json({ ...viewStats(this.stats, ctx), isNewVisitor });
      }
      case "/click": {
        recordClick(this.stats, ctx);
        await this.#persist();
        return json(viewStats(this.stats, ctx));
      }
      case "/stats": {
        return json(viewStats(this.stats, ctx));
      }
      case "/reset": {
        this.stats = createStats(now);
        await this.#persist();
        return json(viewStats(this.stats, ctx));
      }
      default: {
        return json({ error: "not_found" }, 404);
      }
    }
  }
  #persist() {
    return this.state.storage.put(STORAGE_KEY, this.stats);
  }
};

// src/index.js
var VERSION = "1.0.0";
var COOKIE_NAME = "_vid";
var COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
var UID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
var SIGN_WINDOW_S = 600;
var SPAN = 7;
var recentHits = /* @__PURE__ */ new Map();
var RECENT_MAX = 4096;
var warnedWeakSecret = false;
var index_default = {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch {
      return notFound();
    }
  }
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
      return await isTrusted(request, cfg) ? json2(ordinalView(await readStats(store, params))) : notFound();
    case "c":
      return await isTrusted(request, cfg) ? handleClick(store, params) : notFound();
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
function config(env) {
  const target = safeUrl(env?.TARGET_URL) ?? safeUrl("https://www.yzzx.org");
  const secret = text(env?.API_SECRET, "", 256) || DEFAULT_SECRET;
  if (secret === DEFAULT_SECRET && !warnedWeakSecret) {
    warnedWeakSecret = true;
    console.warn(
      "[cf-visit-gateway] API_SECRET 未配置：接口路径与签名使用公开默认盐，仅具备混淆强度。请执行 `npx wrangler secret put API_SECRET` 后再部署。"
    );
  }
  return {
    target,
    host: new URL(target).host,
    title: text(env?.SITE_TITLE, "本站访客统计", 60),
    tz: clampInt(env?.TZ_OFFSET, 8, -12, 14),
    auto: clampInt(env?.AUTO_REDIRECT, 0, 0, 300),
    minInterval: clampInt(env?.MIN_INTERVAL_MS, 1200, 0, 6e4),
    adminToken: text(env?.ADMIN_TOKEN, "", 200),
    secret,
    hardened: secret !== DEFAULT_SECRET,
    badge: truthy(env?.ENABLE_BADGE)
  };
}
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
async function servePage(cfg) {
  const paths = await derivePaths(cfg.secret);
  const nonce = randomId(16);
  const token = await mintToken(cfg.secret, Date.now(), SIGN_WINDOW_S);
  const payload = JSON.stringify({
    t: cfg.target,
    // 目标地址
    h: cfg.host,
    a: cfg.auto,
    // 自动跳转秒数
    g: paths.action.g,
    // 跳转路径
    v: paths.action.v,
    // 记访问路径
    s: paths.action.s,
    // 读统计路径
    k: token
    // 时间窗签名，非密钥
  }).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
  const html = page_default.replaceAll("{{TITLE}}", escapeHtml(cfg.title)).replaceAll("{{HOST}}", escapeHtml(cfg.host)).replaceAll("{{JUMP}}", escapeHtml(paths.action.g)).replaceAll("{{NONCE}}", nonce).replaceAll("{{CONFIG_JSON}}", payload);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 页面携带会过期的签名，禁止任何中间层缓存
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin"
    }
  });
}
async function handleVisit(request, cfg, store, params) {
  if (!await isTrusted(request, cfg)) return notFound();
  const { uid, fresh } = ensureUid(request);
  const uidHash = await hashUid(uid);
  const throttled = shouldThrottle(clientIp(request), params.now, cfg.minInterval);
  const view = store.mode === "none" ? emptyView(params) : throttled ? await store.stats({ ...params, uidHash }) : await store.visit({ ...params, uidHash });
  const headers = new Headers({ "cache-control": "no-store" });
  if (fresh) headers.append("set-cookie", uidCookie(uid));
  return json2({ ...ordinalView(view), counted: store.mode !== "none" && !throttled, isNewVisitor: view.isNewVisitor }, 200, headers);
}
function ordinalView(view) {
  return { configured: view.configured, uv: view.uv, first: view.first };
}
async function handleClick(store, params) {
  if (store.mode === "none") return json2(emptyView(params));
  return json2(await store.click(params));
}
async function readStats(store, params) {
  return store.mode === "none" ? emptyView(params) : store.stats(params);
}
async function handleGo(cfg, store, params, ctx) {
  if (store.mode !== "none") {
    const task = store.click(params).catch(() => {
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
  return new Response(null, {
    status: 302,
    headers: { location: cfg.target, "cache-control": "no-store", "referrer-policy": "no-referrer" }
  });
}
async function handleReset(request, cfg, store, params) {
  if (!cfg.adminToken) return notFound();
  if (request.method !== "POST") return notFound();
  if (!safeEqual(adminTokenOf(request), cfg.adminToken)) return notFound();
  const view = await store.reset(params);
  return json2({ ok: true, ...view });
}
async function handleHealth(request, cfg, store, url, paths) {
  if (!cfg.adminToken) return notFound();
  if (!safeEqual(adminTokenOf(request), cfg.adminToken)) return notFound();
  const view = await readStats(store, { now: Date.now(), tz: cfg.tz, span: SPAN });
  return json2({
    ok: true,
    version: VERSION,
    mode: store.mode,
    hardened: cfg.hardened,
    badge: cfg.badge,
    resetEnabled: true,
    target: cfg.target,
    tz: cfg.tz,
    jump: `${url.origin}${paths.action.g}`,
    stats: { configured: view.configured, total: view.total, uv: view.uv, clicks: view.clicks, today: view.today }
  });
}
var METRICS = {
  uv: { key: "uv", label: "visitors" },
  total: { key: "total", label: "visits" },
  today: { key: "today", label: "today" },
  clicks: { key: "clicks", label: "clicks" }
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
      "x-content-type-options": "nosniff"
    }
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
function textWidth(s) {
  let width = 0;
  for (const ch of String(s)) width += ch.codePointAt(0) > 255 ? 11 : 6.2;
  return Math.round(width);
}
async function isTrusted(request, cfg) {
  if (!sameOrigin(request)) return false;
  return verifyToken(cfg.secret, request.headers.get("x-sig") || "", Date.now(), SIGN_WINDOW_S);
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
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
    "Secure"
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
async function hashUid(uid) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
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
function notFound() {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}
function json2(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(extra instanceof Headers ? extra.entries() : Object.entries(extra))
    }
  });
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeXml(s) {
  return escapeHtml(s);
}
function avatarImage() {
  const bytes = naiwa_default instanceof ArrayBuffer ? new Uint8Array(naiwa_default) : naiwa_default;
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff"
    }
  });
}
function favicon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#0b1020"/><circle cx="32" cy="32" r="17" fill="none" stroke="url(#a)" stroke-width="4"/><circle cx="32" cy="32" r="6" fill="url(#a)"/></svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff"
    }
  });
}
export {
  Counter,
  index_default as default
};
