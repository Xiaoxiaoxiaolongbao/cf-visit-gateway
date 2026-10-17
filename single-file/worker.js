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

  .metrics {
    display: grid; grid-template-columns: repeat(3, 1fr); list-style: none;
    margin: 46px 0 0; padding: 22px 0 20px;
    border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair);
    animation: reveal 1.1s .4s var(--ease) both;
  }
  .metrics li { position: relative; }
  .metrics li + li::before {
    content: ""; position: absolute; left: 0; top: 6%; height: 88%; width: 1px; background: var(--hair);
  }
  .metrics em {
    display: block; margin-bottom: 7px; font-family: var(--mono); font-style: normal;
    font-size: 9.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--ink-soft);
  }
  .metrics strong {
    display: block; font-size: 20px; font-weight: 500; color: var(--paper);
    letter-spacing: -.01em; font-variant-numeric: tabular-nums;
  }
  .metrics span { display: block; margin-top: 3px; font-size: 11px; color: var(--ink-soft); letter-spacing: .04em; }

  .panel { margin-top: 32px; animation: reveal 1.1s .46s var(--ease) both; }
  .panel-head {
    display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px;
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .2em;
    text-transform: uppercase; color: var(--ink-soft);
  }
  .panel-head .muted { font-variant-numeric: tabular-nums; letter-spacing: .14em; }
  .chart { display: flex; align-items: flex-end; gap: 14px; list-style: none; margin: 0; padding: 0 2px; }
  .chart li { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 9px; }
  .chart .bar { width: 100%; max-width: 22px; height: 58px; display: flex; align-items: flex-end; }
  .chart .bar i {
    display: block; width: 100%; height: 0; border-radius: 1.5px;
    background: var(--paper); opacity: .16;
    transition: height .95s var(--ease), opacity .35s ease;
  }
  .chart li:hover .bar i { opacity: .34; }
  .chart li.today .bar i { opacity: .88; }
  .chart em {
    font-family: var(--mono); font-style: normal; font-size: 9px; letter-spacing: .08em;
    color: var(--ink-soft); font-variant-numeric: tabular-nums;
  }
  .chart li.today em { color: var(--ink); }

  .status {
    margin: 32px 0 0; min-height: 17px; font-size: 11.5px; letter-spacing: .03em; color: var(--ink-soft);
    animation: reveal 1.1s .52s var(--ease) both;
  }
  .status[data-state="ok"] { color: var(--ink); }
  .status[data-state="warn"] { color: #d8bb62; }
  .status[data-state="error"] { color: #d98b86; }

  .foot {
    margin: 20px 0 0; padding-top: 18px; border-top: 1px solid var(--hair);
    font-size: 10.5px; line-height: 1.9; color: var(--ink-soft); letter-spacing: .03em;
    animation: reveal 1.1s .58s var(--ease) both;
  }
  .foot b { font-weight: 400; color: var(--ink); font-family: var(--mono); letter-spacing: .1em; }
  .foot span { display: block; }

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
    .metrics { margin-top: 32px; padding: 16px 0 14px; }
    .panel { margin-top: 24px; }
    .status { margin-top: 24px; }
    .foot { margin-top: 16px; padding-top: 14px; }
  }
  @media (max-width: 520px) {
    body { padding: 32px 20px 28px; }
    .seam { margin-bottom: 26px; }
    .kicker { margin-bottom: 24px; letter-spacing: .16em; }
    .exhibit { width: min(232px, 60vw, 30vh); }
    .plate { margin-top: 18px; padding-bottom: 16px; }
    .headline { margin-top: 26px; }
    .cta-wrap { margin-top: 30px; }
    .metrics { margin-top: 36px; }
    .chart { gap: 10px; }
    .chart .bar { height: 48px; }
    .foot { font-size: 10px; }
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
      <img class="naiwa-img" src="/naiwa.jpg" alt="奶蛙" width="384" height="384" decoding="async" fetchpriority="high">
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
    <b>奶蛙 &middot; 抱头震惊 &middot; № 02</b>
    <span class="detail">态度：震惊 / 材质：奶 / 来源：民间</span>
    <span class="detail">状态：常设展 &middot; 无需门票</span>
  </p>

  <p class="headline">
    你是第
    <span class="num" id="uv" aria-live="polite">&ndash;</span>
    位来到该网站的访客
  </p>

  <p class="serial">Visitor Record</p>

  <div class="cta-wrap">
    <a class="cta" id="cta" href="{{JUMP}}">前往扬州中学
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
    </a>
    <p class="dest">{{HOST}}</p>
  </div>

  <ul class="metrics">
    <li><em>Total</em><strong id="m-total">&ndash;</strong><span>总访问</span></li>
    <li><em>Today</em><strong id="m-today">&ndash;</strong><span>今日</span></li>
    <li><em>Clicks</em><strong id="m-clicks">&ndash;</strong><span>跳转</span></li>
  </ul>

  <section class="panel">
    <div class="panel-head"><span>近七日 &middot; 单位人次</span><span class="muted" id="range"></span></div>
    <ul class="chart" id="chart" aria-label="近 7 天访问量"></ul>
  </section>

  <p class="status" id="status" aria-live="polite">正在调阅登记簿…</p>

  <footer class="foot">
    <span><b id="since">—</b></span>
    <span>本页为非官方粉丝页面，与扬州中学无隶属关系。</span>
  </footer>
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
        var height = point.pv > 0 ? Math.max(9, Math.round(ratio * 100)) : 3;
        var parts = point.d.split("-");
        var label = Number(parts[1]) + "/" + Number(parts[2]);
        var cls = point.d === todayKey ? ' class="today"' : "";
        return "<li" + cls + ' title="' + point.d + " · " + point.pv + ' 人次">' +
          '<span class="bar"><i data-height="' + height + '%"></i></span><em>' + label + "</em></li>";
      }).join("");
      byId("range").textContent = series.length ? series[0].d.slice(5) + " — " + todayKey.slice(5) : "";
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
          ? "登记簿启用 " + new Date(view.first).toLocaleDateString("zh-CN")
          : "登记簿未启用";
        setStatus(view.counted === false ? "同一访客的重复到访已合并" : "本次到访已记入登记簿", "ok");
      } else {
        paintChart([]);
        setStatus("登记簿暂不可用", "warn");
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
        setStatus(seconds + " 秒后前往 " + (cfg.h || ""), "warn");
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
          else setStatus("登记簿读取失败，可直接点击上方按钮前往", "error");
          scheduleAutoRedirect();
        })
        .catch(function () {
          setStatus("登记簿读取失败，可直接点击上方按钮前往", "error");
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
