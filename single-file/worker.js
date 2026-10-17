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
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; min-height: 100svh; display: flex; align-items: center; justify-content: center;
    padding: 28px 18px; overflow-x: hidden; background: #070911; color: #e9ecf6;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ""; position: fixed; inset: -20% -10%; z-index: -2; pointer-events: none; filter: blur(12px);
    background:
      radial-gradient(60% 45% at 15% 0%, rgba(99, 102, 241, .30), transparent 65%),
      radial-gradient(50% 40% at 100% 5%, rgba(34, 211, 238, .20), transparent 60%),
      radial-gradient(55% 50% at 50% 110%, rgba(168, 85, 247, .18), transparent 65%);
  }
  body::after {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: .55;
    background-image:
      linear-gradient(rgba(255, 255, 255, .035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, .035) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(70% 60% at 50% 40%, #000 20%, transparent 100%);
  }

  .card {
    position: relative; width: min(460px, 100%); padding: 26px 24px 18px;
    border: 1px solid rgba(255, 255, 255, .09); border-radius: 26px;
    background: linear-gradient(180deg, rgba(255, 255, 255, .055), rgba(255, 255, 255, .018));
    box-shadow: 0 40px 90px -40px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .05);
    backdrop-filter: blur(16px) saturate(140%);
    animation: rise .7s cubic-bezier(.2, .8, .2, 1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }

  /* 顶部圆形奶蛙头像 */
  .avatar {
    width: 190px; height: 190px; margin: 4px auto 18px; border-radius: 50%;
    overflow: hidden; position: relative; isolation: isolate;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, .10),
      0 0 0 9px rgba(255, 255, 255, .028),
      0 26px 60px -26px rgba(52, 211, 153, .55),
      0 0 80px -12px rgba(99, 102, 241, .40);
    animation: float 6s ease-in-out infinite;
  }
  .avatar svg { display: block; width: 100%; height: 100%; }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-7px); }
  }

  h1 { margin: 0 0 16px; font-size: 13px; font-weight: 500; letter-spacing: .07em; color: #8e99b3; text-align: center; }

  .hero { text-align: center; margin: 0; }
  .visitor-line { margin: 0; font-size: 15.5px; line-height: 1.75; color: #c8d2e8; letter-spacing: .01em; }
  .visitor-line .num {
    display: inline-block; min-width: 1ch; padding: 0 7px; vertical-align: -5px;
    font-size: 42px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums;
    background: linear-gradient(120deg, #ffffff 8%, #c7d2fe 46%, #67e8f9 92%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    text-shadow: 0 0 50px rgba(99, 102, 241, .38);
  }

  .metrics {
    display: grid; grid-template-columns: repeat(3, 1fr); list-style: none; margin: 18px 0 0; padding: 14px 0;
    border-top: 1px solid rgba(255, 255, 255, .07); border-bottom: 1px solid rgba(255, 255, 255, .07);
  }
  .metrics li { position: relative; text-align: center; }
  .metrics li + li::before {
    content: ""; position: absolute; left: 0; top: 14%; height: 72%; width: 1px; background: rgba(255, 255, 255, .07);
  }
  .metrics strong { display: block; font-size: 19px; font-weight: 600; color: #eef2ff; font-variant-numeric: tabular-nums; }
  .metrics span { font-size: 11.5px; letter-spacing: .04em; color: #7f8aa3; }

  .panel { margin-top: 18px; }
  .panel-head { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 12px; color: #8e99b3; }
  .panel-head .muted { color: #647088; }
  .chart { display: flex; align-items: flex-end; gap: 8px; list-style: none; margin: 0; padding: 0; }
  .chart li { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .chart .bar { width: 100%; height: 74px; display: flex; align-items: flex-end; }
  .chart .bar i {
    display: block; width: 100%; height: 0; border-radius: 8px 8px 4px 4px; opacity: .82;
    background: linear-gradient(180deg, #818cf8, #22d3ee);
    box-shadow: 0 6px 18px -10px rgba(99, 102, 241, .95);
    transition: height .8s cubic-bezier(.2, .8, .2, 1), opacity .25s;
  }
  .chart li:hover .bar i { opacity: 1; }
  .chart em { font-size: 10.5px; font-style: normal; color: #68738c; font-variant-numeric: tabular-nums; }
  .chart li.today em { color: #a5b4fc; }
  .chart li.today .bar i { background: linear-gradient(180deg, #a5b4fc, #67e8f9); }

  .cta {
    position: relative; overflow: hidden; margin-top: 20px; display: flex; align-items: center;
    justify-content: space-between; gap: 12px; padding: 14px 16px; border-radius: 16px;
    text-decoration: none; color: #fff; background: linear-gradient(120deg, #4f46e5, #6366f1 45%, #22d3ee 135%);
    box-shadow: 0 18px 40px -18px rgba(79, 70, 229, .95), inset 0 1px 0 rgba(255, 255, 255, .25);
    transition: transform .18s cubic-bezier(.2, .8, .2, 1), box-shadow .18s, filter .18s;
  }
  .cta::after {
    content: ""; position: absolute; inset: 0; transform: translateX(-120%); transition: transform .7s ease;
    background: linear-gradient(100deg, transparent 32%, rgba(255, 255, 255, .22) 50%, transparent 68%);
  }
  .cta:hover::after { transform: translateX(120%); }
  .cta:hover { transform: translateY(-2px); filter: saturate(115%); box-shadow: 0 24px 52px -20px rgba(99, 102, 241, 1); }
  .cta:active { transform: translateY(0) scale(.995); }
  .cta:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 3px; }
  .cta-main { display: flex; flex-direction: column; gap: 1px; }
  .cta-main strong { font-size: 15.5px; font-weight: 650; letter-spacing: .01em; }
  .cta-main em { font-size: 11.5px; font-style: normal; letter-spacing: .02em; opacity: .85; }
  .cta svg { width: 22px; height: 22px; flex: none; transition: transform .18s; }
  .cta:hover svg { transform: translateX(3px); }

  .status {
    display: flex; align-items: center; justify-content: center; gap: 7px;
    margin: 14px 0 0; min-height: 18px; font-size: 12px; color: #7f8aa3; text-align: center;
  }
  .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #5f6a80; flex: none; }
  .status[data-state="ok"]::before { background: #34d399; box-shadow: 0 0 8px rgba(52, 211, 153, .85); }
  .status[data-state="warn"] { color: #fcd34d; }
  .status[data-state="warn"]::before { background: #fcd34d; }
  .status[data-state="error"] { color: #fca5a5; }
  .status[data-state="error"]::before { background: #fca5a5; }
  .foot {
    display: flex; justify-content: center; gap: 8px; margin-top: 14px; padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, .06); font-size: 11px; color: #5f6a80;
  }

  @media (max-width: 400px) {
    .card { padding: 22px 18px 16px; border-radius: 22px; }
    .avatar { width: 150px; height: 150px; margin-bottom: 14px; }
    .visitor-line { font-size: 14.5px; }
    .visitor-line .num { font-size: 36px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  }
</style>
</head>
<body>
<main class="card">
  <!-- 奶蛙头像：内联手绘 SVG，不引任何外部图片（零外链、可无限放大不失真） -->
  <div class="avatar">
    <svg viewBox="0 0 200 200" role="img" aria-label="奶蛙">
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
      <!-- 头顶奶泡 -->
      <circle cx="78" cy="52" r="17" fill="#ffffff" opacity=".93"/>
      <circle cx="101" cy="41" r="23" fill="#ffffff"/>
      <circle cx="125" cy="53" r="15" fill="#ffffff" opacity=".90"/>
      <!-- 头 -->
      <ellipse cx="100" cy="120" rx="61" ry="53" fill="url(#naiwaSkin)"/>
      <!-- 凸出的两只大眼 -->
      <circle cx="64" cy="78" r="26" fill="#f7fffb"/>
      <circle cx="136" cy="78" r="26" fill="#f7fffb"/>
      <circle cx="66" cy="80" r="12" fill="#17281f"/>
      <circle cx="134" cy="80" r="12" fill="#17281f"/>
      <circle cx="61" cy="74" r="4.4" fill="#ffffff"/>
      <circle cx="129" cy="74" r="4.4" fill="#ffffff"/>
      <!-- 鼻孔 -->
      <circle cx="90" cy="124" r="3.2" fill="#3c6b52" opacity=".65"/>
      <circle cx="110" cy="124" r="3.2" fill="#3c6b52" opacity=".65"/>
      <!-- 微笑 -->
      <path d="M76 142 q24 22 48 0" fill="none" stroke="#2f5d43" stroke-width="5" stroke-linecap="round"/>
      <!-- 腮红 -->
      <ellipse cx="46" cy="146" rx="14" ry="9" fill="#ff9db1" opacity=".45"/>
      <ellipse cx="154" cy="146" rx="14" ry="9" fill="#ff9db1" opacity=".45"/>
    </svg>
  </div>

  <h1>{{TITLE}}</h1>

  <section class="hero">
    <p class="visitor-line">你是第 <span class="num" id="uv" aria-live="polite">&ndash;</span> 位来到该网站的访客</p>
  </section>

  <ul class="metrics">
    <li><strong id="m-total">&ndash;</strong><span>总访问</span></li>
    <li><strong id="m-today">&ndash;</strong><span>今日</span></li>
    <li><strong id="m-clicks">&ndash;</strong><span>跳转</span></li>
  </ul>

  <section class="panel">
    <div class="panel-head"><span>近 7 天</span><span class="muted" id="range"></span></div>
    <ul class="chart" id="chart" aria-label="近 7 天访问量"></ul>
  </section>

  <a class="cta" id="cta" href="{{JUMP}}">
    <span class="cta-main"><strong>单击访问</strong><em>{{HOST}}</em></span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </a>

  <p class="status" id="status" aria-live="polite">正在读取访问数据…</p>
  <footer class="foot"><span id="since">&nbsp;</span></footer>
</main>

<script id="cfg" type="application/json" nonce="{{NONCE}}">{{CONFIG_JSON}}<\/script>
<script nonce="{{NONCE}}">
  (function () {
    "use strict";

    var cfg = {};
    try { cfg = JSON.parse(document.getElementById("cfg").textContent || "{}"); } catch (err) { cfg = {}; }

    var byId = function (id) { return document.getElementById(id); };
    var nf = new Intl.NumberFormat("zh-CN");
    var countUpTimers = new WeakMap();

    function countUp(el, target) {
      var from = Number(el.dataset.value || 0);
      var start = performance.now();
      var duration = 850;
      var previous = countUpTimers.get(el);
      if (previous) cancelAnimationFrame(previous);
      el.dataset.value = String(target);
      if (from === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.textContent = nf.format(target);
        return;
      }
      (function step(now) {
        var p = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = nf.format(Math.round(from + (target - from) * eased));
        if (p < 1) countUpTimers.set(el, requestAnimationFrame(step));
      })(start);
    }

    function setStatus(message, state) {
      var el = byId("status");
      el.textContent = message;
      if (state) el.dataset.state = state; else el.removeAttribute("data-state");
    }

    function paintChart(series) {
      var chart = byId("chart");
      var max = series.reduce(function (m, point) { return Math.max(m, point.pv); }, 0);
      var todayKey = series.length ? series[series.length - 1].d : "";
      chart.innerHTML = series.map(function (point) {
        var ratio = max > 0 ? point.pv / max : 0;
        var height = point.pv > 0 ? Math.max(8, Math.round(ratio * 100)) : 3;
        var parts = point.d.split("-");
        var label = Number(parts[1]) + "/" + Number(parts[2]);
        var cls = point.d === todayKey ? ' class="today"' : "";
        return "<li" + cls + ' title="' + point.d + " · " + point.pv + ' 次访问">' +
          '<span class="bar"><i data-height="' + height + '%"></i></span><em>' + label + "</em></li>";
      }).join("");
      byId("range").textContent = series.length ? series[0].d.slice(5) + " → " + todayKey.slice(5) : "";
      requestAnimationFrame(function () {
        Array.prototype.forEach.call(chart.querySelectorAll("i"), function (bar) {
          bar.style.height = bar.dataset.height;
        });
      });
    }

    function render(view) {
      if (view.configured !== false) {
        countUp(byId("uv"), view.uv || 0);
        countUp(byId("m-total"), view.total || 0);
        countUp(byId("m-today"), view.today || 0);
        countUp(byId("m-clicks"), view.clicks || 0);
        paintChart(Array.isArray(view.series) ? view.series : []);
        byId("since").textContent = view.first
          ? "自 " + new Date(view.first).toLocaleDateString("zh-CN") + " 起记录"
          : "尚无记录";
        setStatus(view.counted === false ? "短时间内的重复访问已合并 · 本次未重复计数" : "本次访问已计入统计", "ok");
      } else {
        paintChart([]);
        setStatus("暂无可用统计", "warn");
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
        setStatus(seconds + " 秒后自动前往 " + (cfg.h || ""), "warn");
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
          else setStatus("统计读取失败，可直接点击上方按钮前往", "error");
          scheduleAutoRedirect();
        })
        .catch(function () {
          setStatus("统计读取失败，可直接点击上方按钮前往", "error");
        });
    }

    byId("cta").addEventListener("click", function () {
      setStatus("正在前往 " + (cfg.h || "") + " …");
    });

    boot();
  })();
<\/script>
</body>
</html>
`;

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
  if (url.pathname === "/" || url.pathname === "/index.html") return servePage(cfg);
  if (url.pathname === "/favicon.svg") return favicon();
  const paths = await derivePaths(cfg.secret);
  const action = paths.byPath.get(url.pathname);
  if (!action) return notFound();
  const store = createStore(env);
  const params = { now: Date.now(), tz: cfg.tz, span: SPAN };
  switch (action) {
    case "v":
      return handleVisit(request, cfg, store, params);
    case "s":
      return await isTrusted(request, cfg) ? json2(await readStats(store, params)) : notFound();
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
  return json2({ ...view, counted: store.mode !== "none" && !throttled }, 200, headers);
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
