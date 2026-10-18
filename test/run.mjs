/**
 * 零依赖集成测试：用内存版 KV / Durable Object 模拟 Cloudflare 运行时，
 * 直接跑真实的 src/index.js 路由、隐藏路径推导、签名校验与状态机。
 *
 * 运行：npm test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register("./html-loader.mjs", import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));

const { Counter } = await import("../src/durable.js");
const { default: worker } = await import("../src/index.js");
const { derivePaths, mintToken, verifyToken, DEFAULT_SECRET } = await import("../src/secret.js");
const S = await import("../src/stats.js");

const SECRET_A = "unit-test-secret-alpha";
const SECRET_B = "unit-test-secret-bravo";
const ADMIN_A = "unit-test-admin-token";

/* ------------------------------------------------------------- 测试脚手架 */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class MockStorage {
  constructor() {
    this.map = new Map();
    this.writes = 0;
  }
  async get(key) {
    const value = this.map.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async put(key, value) {
    this.writes += 1;
    this.map.set(key, structuredClone(value));
  }
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
  blockConcurrencyWhile(fn) {
    return Promise.resolve().then(fn);
  }
}

class MockKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const raw = this.map.get(key);
    if (raw === undefined || raw === null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
}

/** 模拟 Durable Object 命名空间绑定 */
function mockDO() {
  const instances = new Map();
  return {
    idFromName: (name) => `id:${name}`,
    get: (id) => ({
      async fetch(input, init) {
        if (!instances.has(id)) instances.set(id, new Counter(new MockState(), {}));
        const request = input instanceof Request ? input : new Request(input, init);
        return instances.get(id).fetch(request);
      },
    }),
    instances,
  };
}

function makeEnv(extra = {}) {
  return {
    TARGET_URL: "https://www.yzzx.org",
    SITE_TITLE: "测试站点",
    TZ_OFFSET: "8",
    AUTO_REDIRECT: "0",
    MIN_INTERVAL_MS: "0",
    API_SECRET: SECRET_A,
    ...extra,
  };
}

function makeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil: (p) => pending.push(Promise.resolve(p)),
    passThroughOnException: () => {},
    async settle() {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
}

const ORIGIN = "https://gateway.example";

async function hit(env, path, init = {}, ctx = makeCtx()) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  return { res, ctx };
}

/** 打开首页，并把页面真正注入给浏览器的配置解析出来（测试即客户端） */
async function openSite(env) {
  const { res } = await hit(env, "/");
  const html = await res.text();
  const raw = /<script id="cfg"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  const jump = /<a class="cta" id="cta" href="([^"]*)"/.exec(html);
  return { res, html, cfg: raw ? JSON.parse(raw[1]) : {}, jump: jump ? jump[1] : "" };
}

/** 带上页面签名的请求（浏览器里发生的事） */
async function visit(env, cfg, headers = {}) {
  return hit(env, cfg.v, { method: "POST", headers: { "x-sig": cfg.k, ...headers } });
}

/** 运维视角：通过 /<prefix>/h（需 ADMIN_TOKEN）读取完整统计 */
async function adminStats(env) {
  const paths = await derivePaths(SECRET_A);
  const res = await (await hit(env, paths.action.h, { headers: { "x-admin-token": ADMIN_A } })).res;
  if (!res.ok) throw new Error(`health endpoint failed: ${res.status}`);
  return res.json();
}

async function readStats(env, cfg, headers = {}) {
  const { res } = await hit(env, cfg.s, { headers: { "x-sig": cfg.k, ...headers } });
  return res.json();
}

/** 把响应折叠成可比较的指纹，用于验证"失败响应不可区分" */
async function fingerprint(res) {
  const body = await res.text();
  return JSON.stringify({
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body,
  });
}

const post = (headers = {}) => ({ method: "POST", headers, body: "{}" });

/* ------------------------------------------------------------------ 用例 */

test("stats: dayKey 按配置时区折算日期", () => {
  const utcEvening = Date.UTC(2026, 9, 15, 20, 0, 0);
  assert.equal(S.dayKey(utcEvening, 8), "2026-10-16");
  assert.equal(S.dayKey(utcEvening, 0), "2026-10-15");
  assert.equal(S.dayKey(utcEvening, -5), "2026-10-15");
});

test("stats: UV 去重窗口内只计一次，窗口外重新计", () => {
  const t0 = Date.UTC(2026, 9, 15, 3, 0, 0);
  const state = S.createStats(t0);

  assert.deepEqual(S.recordVisit(state, { uidHash: "visitor-a", now: t0, tz: 8 }), { isNewVisitor: true });
  assert.deepEqual(S.recordVisit(state, { uidHash: "visitor-a", now: t0 + 60000, tz: 8 }), { isNewVisitor: false });
  assert.equal(state.total, 2);
  assert.equal(state.uv, 1);

  const later = t0 + 60000 + S.UV_WINDOW_MS + 1000;
  assert.deepEqual(S.recordVisit(state, { uidHash: "visitor-a", now: later, tz: 8 }), { isNewVisitor: true });
  assert.equal(state.uv, 2);
  assert.equal(state.total, 3);
  assert.ok(Object.keys(state.seen).length <= 20, "seen 表应保持有界");
});

test("stats: 每日明细只保留最近 MAX_DAYS 天", () => {
  const state = S.createStats();
  for (let i = 0; i < 40; i += 1) state.days[S.dayKey(Date.UTC(2026, 0, 1) + i * 86400000, 8)] = 1;
  S.recordVisit(state, { uidHash: "x", now: Date.UTC(2026, 9, 15), tz: 8 });
  assert.equal(Object.keys(state.days).length, S.MAX_DAYS);
});

test("stats: viewStats 输出 7 天序列且不含指纹表", () => {
  const now = Date.UTC(2026, 9, 15, 6, 0, 0);
  const state = S.createStats(now);
  S.recordVisit(state, { uidHash: "a", now, tz: 8 });
  const view = S.viewStats(state, { now, tz: 8 });
  assert.equal(view.series.length, 7);
  assert.equal(view.series.at(-1).d, view.todayKey);
  assert.equal(view.today, 1);
  assert.equal("seen" in view, false);
  assert.equal("days" in view, false);
});

test("stats: 被污染/旧结构数据可被 normalize 修复", () => {
  const now = 1_800_000_000_000;
  const state = S.normalize({ total: "17", uv: -3, days: { "2026-01-01": "5", bad: 9 }, seen: { a: "x" } }, now);
  assert.equal(state.total, 17);
  assert.equal(state.uv, 0);
  assert.deepEqual(state.days, { "2026-01-01": 5 });
  assert.deepEqual(state.seen, {});
  assert.equal(state.first, now);
});

test("secret: 路径由密钥派生，签名按时间窗轮换且与密钥不可互推", async () => {
  const a1 = await derivePaths(SECRET_A);
  const a2 = await derivePaths(SECRET_A);
  const b = await derivePaths(SECRET_B);

  assert.equal(a1.prefix, a2.prefix, "同密钥派生结果必须稳定（否则跨 isolate 路由会漂移）");
  assert.notEqual(a1.prefix, b.prefix, "不同密钥必须派生出不同前缀");
  assert.equal(a1.prefix.length, 16);
  assert.equal(a1.action.v, `/${a1.prefix}/v`);
  assert.equal(a1.byPath.get(a1.action.g), "g");
  assert.equal(a1.byPath.has("/go"), false);

  const now = Date.now();
  const fresh = await mintToken(SECRET_A, now, 600);
  const previous = await mintToken(SECRET_A, now - 600000, 600);
  const ancient = await mintToken(SECRET_A, now - 600000 * 4, 600);

  assert.equal(fresh.length, 32);
  assert.notEqual(fresh, SECRET_A);
  assert.ok(!fresh.includes(SECRET_A));
  assert.equal(await verifyToken(SECRET_A, fresh, now, 600), true);
  assert.equal(await verifyToken(SECRET_A, previous, now, 600), true, "应容忍前一个时间窗");
  assert.equal(await verifyToken(SECRET_A, ancient, now, 600), false, "过期签名必须失效");
  assert.equal(await verifyToken(SECRET_B, fresh, now, 600), false, "换密钥后旧签名立即失效");
  assert.equal(await verifyToken(SECRET_A, "f".repeat(32), now, 600), false);
  assert.equal(await verifyToken(SECRET_A, "", now, 600), false);
  assert.equal(await verifyToken(SECRET_A, fresh.slice(0, 31), now, 600), false);
});

test("durable: 单实例内计数精确且可跨重启恢复", async () => {
  const binding = mockDO();
  const stub = binding.get(binding.idFromName("global"));

  const doVisit = (uid) => stub.fetch(`https://counter.internal/visit?tz=8&uidHash=${uid}`);
  const first = await (await doVisit("hash-a")).json();
  const second = await (await doVisit("hash-a")).json();
  const third = await (await doVisit("hash-b")).json();
  assert.equal(first.isNewVisitor, true);
  assert.equal(second.isNewVisitor, false);
  assert.equal(third.isNewVisitor, true);
  assert.equal(third.total, 3);
  assert.equal(third.uv, 2);

  await (await stub.fetch("https://counter.internal/click?tz=8")).json();
  const view = await (await stub.fetch("https://counter.internal/stats?tz=8")).json();
  assert.equal(view.clicks, 1);

  // 模拟 DO 被驱逐后重启：同一 storage 重新载入状态
  const revived = new Counter(binding.instances.get("id:global").state, {});
  const afterRestart = await (await revived.fetch(new Request("https://counter.internal/stats?tz=8"))).json();
  assert.equal(afterRestart.total, 3, "重启后计数应持久化");
  assert.equal(afterRestart.uv, 2);
});

test("公开面：只暴露 / 与 favicon，旧接口与常见探测路径一律 404", async () => {
  const env = makeEnv({ COUNTER: mockDO() });
  const legacy = [
    "/api/visit", "/api/stats", "/api/click", "/api/reset", "/api/config",
    "/go", "/badge.svg", "/healthz", "/health", "/admin", "/debug",
    "/wp-login.php", "/.env", "/robots.txt",
  ];

  for (const path of legacy) {
    const { res } = await hit(env, path);
    assert.equal(res.status, 404, `${path} 不应存在`);
    assert.equal(await res.text(), "", `${path} 的 404 不应带 body`);
    assert.equal(res.headers.get("content-type"), null, `${path} 不应暴露类型`);
  }

  const favicon = await hit(env, "/favicon.svg");
  assert.equal(favicon.res.status, 200);
  assert.match(favicon.res.headers.get("content-type"), /image\/svg\+xml/);

  const paths = await derivePaths(SECRET_A);
  assert.equal((await hit(env, `/${paths.prefix}/x`)).res.status, 404, "前缀对但动作不对也应 404");
  assert.equal((await hit(env, `/${"0".repeat(16)}/v`, post())).res.status, 404, "错误前缀应 404");
});

test("闭环：页面 → 隐藏路径 → 计数 + Cookie 去重", async () => {
  const env = makeEnv({ COUNTER: mockDO(), ADMIN_TOKEN: ADMIN_A });
  const site = await openSite(env);

  assert.ok(site.cfg.v.startsWith(`/${(await derivePaths(SECRET_A)).prefix}/`), "页面里的路径必须来自密钥派生");
  assert.equal(site.cfg.v.includes("/api/"), false);

  const first = await visit(env, site.cfg);
  assert.equal(first.res.status, 200);
  const v1 = await first.res.json();
  assert.equal(v1.uv, 1);
  assert.equal(v1.counted, true);
  // 对外只给位次：其余计数不得下发到浏览器
  for (const hidden of ["total", "today", "clicks", "series", "last", "todayKey"]) {
    assert.equal(hidden in v1, false, `响应不应包含 ${hidden}`);
  }

  const setCookie = first.res.headers.get("set-cookie");
  assert.match(setCookie, /^_vid=[A-Za-z0-9_-]{22}/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);

  const cookie = setCookie.split(";")[0];
  const second = await visit(env, site.cfg, { cookie });
  const v2 = await second.res.json();
  assert.equal(v2.uv, 1, "同一访客不应重复增加 UV");
  assert.equal("total" in v2, false, "第二次访问同样不暴露总量");
  assert.equal(second.res.headers.get("set-cookie"), null, "已有合法 Cookie 时不应重复下发");

  // 服务端仍在完整计数：运维接口（需令牌）能看到 total / today / clicks
  const admin = await adminStats(env);
  assert.equal(admin.stats.total, 2, "同一访客再次访问应增加 PV");
  assert.equal(admin.stats.today, 2);
  assert.equal(admin.stats.uv, 1);

  const stats = await readStats(env, site.cfg);
  assert.equal(stats.uv, 1);
  assert.equal("total" in stats, false, "只读接口同样只给位次");
  assert.equal("seen" in stats, false, "对外视图不得包含访客指纹表");
});

test("失败响应不可区分：错路径 / 无签名 / 假签名 / 跨源 逐字节一致", async () => {
  const env = makeEnv({ COUNTER: mockDO() });
  const site = await openSite(env);

  const prints = [];
  prints.push(await fingerprint((await hit(env, "/nope")).res));
  prints.push(await fingerprint((await hit(env, site.cfg.v, post())).res));
  prints.push(await fingerprint((await hit(env, site.cfg.v, post({ "x-sig": "f".repeat(32) }))).res));
  prints.push(await fingerprint((await hit(env, site.cfg.s)).res));
  prints.push(await fingerprint((await hit(env, site.cfg.v, post({ "x-sig": site.cfg.k, origin: "https://evil.example" }))).res));

  assert.equal(new Set(prints).size, 1, "所有失败必须返回完全相同的 404（否则就是探测预言机）");
});

test("签名有效期：前一个时间窗仍可用，过期立即失效", async () => {
  const env = makeEnv({ COUNTER: mockDO() });
  const site = await openSite(env);

  const previous = await mintToken(SECRET_A, Date.now() - 600000, 600);
  assert.equal((await hit(env, site.cfg.v, post({ "x-sig": previous }))).res.status, 200);

  const ancient = await mintToken(SECRET_A, Date.now() - 600000 * 5, 600);
  assert.equal((await hit(env, site.cfg.v, post({ "x-sig": ancient }))).res.status, 404);
});

test("跳转：只需不可猜前缀即可 302，且计入跳转次数", async () => {
  const env = makeEnv({ COUNTER: mockDO(), ADMIN_TOKEN: ADMIN_A });
  const site = await openSite(env);
  const paths = await derivePaths(SECRET_A);

  assert.equal(site.jump, paths.action.g, "页面按钮必须指向派生跳转路径");

  // 模拟把链接直接粘进地址栏：没有签名、没有 Origin
  const bare = await hit(env, site.jump);
  assert.equal(bare.res.status, 302);
  assert.equal(bare.res.headers.get("location"), "https://www.yzzx.org/");
  assert.equal(bare.res.headers.get("cache-control"), "no-store");
  await bare.ctx.settle();

  const stats = await readStats(env, site.cfg);
  assert.equal("clicks" in stats, false, "跳转次数不对外下发");
  const admin = await adminStats(env);
  assert.equal(admin.stats.clicks, 1, "跳转次数应被记录");
  assert.equal(admin.stats.total, 0, "跳转不应污染访问量");

  assert.equal((await hit(env, "/go")).res.status, 404, "裸 /go 已不存在");
});

test("页面与产物不泄露密钥：只有签名，没有密钥；CSP nonce 生效", async () => {
  const env = makeEnv({ COUNTER: mockDO(), API_SECRET: SECRET_A, ADMIN_TOKEN: ADMIN_A });
  const site = await openSite(env);

  assert.ok(!site.html.includes(SECRET_A), "页面不得包含 API_SECRET");
  assert.ok(!site.html.includes(ADMIN_A), "页面不得包含 ADMIN_TOKEN");
  assert.ok(!site.html.includes("API_SECRET"), "页面不得出现密钥变量名");
  assert.ok(!site.html.includes("ADMIN_TOKEN"), "页面不得出现密钥变量名");
  assert.ok(!site.html.includes("{{"), "占位符必须全部替换");
  assert.ok(site.html.includes(site.cfg.k), "页面应携带时间窗签名供浏览器使用");
  assert.notEqual(site.cfg.k, SECRET_A);

  assert.equal(site.res.headers.get("cache-control"), "no-store", "带签名的页面禁止缓存");
  const csp = site.res.headers.get("content-security-policy");
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)[1];
  assert.equal(site.html.split(`nonce="${nonce}"`).length - 1, 4, "style、pre-paint 主题脚本与两段业务脚本都要带 nonce");
  assert.equal(site.res.headers.get("referrer-policy"), "no-referrer");
});

test("徽章默认关闭，显式开启后位于隐藏路径且只读", async () => {
  const paths = await derivePaths(SECRET_A);

  const closed = makeEnv({ COUNTER: mockDO() });
  assert.equal((await hit(closed, paths.action.b)).res.status, 404, "默认不开放徽章");
  assert.equal((await openSite(closed)).html.includes("badge"), false);

  const open = makeEnv({ COUNTER: mockDO(), ENABLE_BADGE: "true" });
  const site = await openSite(open);
  await visit(open, site.cfg);

  const badge = await hit(open, paths.action.b);
  assert.equal(badge.res.status, 200);
  assert.match(badge.res.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await badge.res.text();
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes("visitors"));
  assert.ok(svg.includes(">1<"));

  const total = await (await hit(open, `${paths.action.b}?metric=total&label=%E8%AE%BF%E9%97%AE`)).res.text();
  assert.ok(total.includes("访问"));
});

test("运维接口：清零与自检都需要令牌，且不回显令牌", async () => {
  const env = makeEnv({ COUNTER: mockDO(), ADMIN_TOKEN: ADMIN_A });
  const paths = await derivePaths(SECRET_A);
  const site = await openSite(env);
  await visit(env, site.cfg);

  assert.equal((await hit(env, paths.action.r, post())).res.status, 404, "无令牌 404");
  assert.equal((await hit(env, paths.action.r, post({ "x-admin-token": "wrong" }))).res.status, 404, "错令牌 404");
  assert.equal((await hit(env, paths.action.h)).res.status, 404, "自检无令牌 404");
  assert.equal((await hit(env, paths.action.r, { method: "GET", headers: { "x-admin-token": ADMIN_A } })).res.status, 404);

  const reset = await hit(env, paths.action.r, post({ authorization: `Bearer ${ADMIN_A}` }));
  assert.equal(reset.res.status, 200);
  const body = await reset.res.json();
  assert.equal(body.ok, true);
  assert.equal(body.total, 0);
  assert.equal(body.uv, 0);
  assert.ok(!JSON.stringify(body).includes(ADMIN_A), "响应不得回显令牌");

  const after = await adminStats(env);
  assert.equal(after.stats.total, 0, "清零后统计应归零");

  const health = await hit(env, paths.action.h, { headers: { "x-admin-token": ADMIN_A } });
  const info = await health.res.json();
  assert.equal(info.mode, "durable");
  assert.equal(info.hardened, true, "设置了 API_SECRET 应报告已加固");
  assert.equal(info.target, "https://www.yzzx.org/");
  assert.ok(info.jump.endsWith(paths.action.g));
  assert.ok(!JSON.stringify(info).includes(ADMIN_A));
  assert.ok(!JSON.stringify(info).includes(SECRET_A));

  const disabled = makeEnv({ COUNTER: mockDO() });
  assert.equal((await hit(disabled, paths.action.r, post({ "x-admin-token": ADMIN_A }))).res.status, 404, "未配置令牌时接口整体关闭");
});

test("内部异常折叠成 404：不吐堆栈、不暴露绑定细节", async () => {
  const boom = {
    idFromName() {
      throw new Error("boom: internal binding failure");
    },
    get() {
      throw new Error("boom: internal binding failure");
    },
  };
  const env = makeEnv({ COUNTER: boom });
  const site = await openSite(env);

  const { res } = await visit(env, site.cfg);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.equal(body, "");
  assert.ok(!body.includes("boom"));
});

test("未配置 API_SECRET 时仍可用，但自检报告未加固", async () => {
  const env = makeEnv({ COUNTER: mockDO(), API_SECRET: "", ADMIN_TOKEN: ADMIN_A });
  const site = await openSite(env);
  const paths = await derivePaths(DEFAULT_SECRET);

  assert.equal(site.cfg.v, paths.action.v, "无密钥时退化为默认盐派生");

  const first = await visit(env, site.cfg);
  assert.equal(first.res.status, 200);
  assert.equal((await first.res.json()).uv, 1);

  const info = await (await hit(env, paths.action.h, { headers: { "x-admin-token": ADMIN_A } })).res.json();
  assert.equal(info.hardened, false, "必须如实报告未加固");
});

test("非法 TARGET_URL 回退到默认值，标题被转义", async () => {
  const env = makeEnv({ COUNTER: mockDO(), TARGET_URL: "javascript:alert(1)", SITE_TITLE: "</script><script>alert(1)" });
  const site = await openSite(env);
  const paths = await derivePaths(SECRET_A);

  const info = await (await hit(env, paths.action.h, { headers: { "x-admin-token": "" } })).res;
  assert.equal(info.status, 404, "没有令牌就看不到自检");

  const jump = await hit(env, site.jump);
  assert.equal(jump.res.headers.get("location"), "https://www.yzzx.org/", "只允许 http/https");

  assert.ok(site.html.includes("&lt;/script&gt;"), "标题必须被 HTML 转义");
  assert.ok(!site.html.includes("<script>alert(1)"), "不得注入可执行脚本");
});

test("未绑定 COUNTER 时降级为 KV 后端（同样走隐藏路径）", async () => {
  const kv = new MockKV();
  const env = makeEnv({ VISITS: kv });
  const site = await openSite(env);
  const paths = await derivePaths(SECRET_A);

  const a = await (await visit(env, site.cfg)).res.json();
  assert.equal(a.uv, 1);
  assert.equal("total" in a, false, "对外只给位次");

  const b = await (await visit(env, site.cfg, { cookie: `_vid=${"b".repeat(22)}` })).res.json();
  assert.equal(b.uv, 2);
  assert.ok(kv.map.has("stats"), "KV 后端应落盘");
  const stored = JSON.parse(kv.map.get("stats"));
  assert.equal(stored.total, 2, "KV 内部仍完整记录 PV");
  assert.equal(stored.uv, 2);

  const info = await (await hit(env, paths.action.h, { headers: { "x-admin-token": ADMIN_A } })).res;
  assert.equal(info.status, 404, "该环境未配置 ADMIN_TOKEN");
});

test("完全未绑定后端时页面可用且不显示假数据", async () => {
  const env = makeEnv();
  const site = await openSite(env);

  const view = await (await visit(env, site.cfg)).res.json();
  assert.equal(view.configured, false);
  assert.equal(view.counted, false);
  assert.equal(view.uv, 0);
  assert.equal("total" in view, false);

  const jump = await hit(env, site.jump);
  assert.equal(jump.res.status, 302, "统计未配置也不能影响跳转");
});

test("同 IP 高频访问不再重复计 PV（防刷新刷量）", async () => {
  const env = makeEnv({ COUNTER: mockDO(), MIN_INTERVAL_MS: "3000", ADMIN_TOKEN: ADMIN_A });
  const site = await openSite(env);
  const ip = { "cf-connecting-ip": "203.0.113.7" };

  const first = await (await visit(env, site.cfg, ip)).res.json();
  const second = await (await visit(env, site.cfg, ip)).res.json();
  assert.equal(first.counted, true);
  assert.equal(second.counted, false);
  assert.equal(second.uv, 1);
  assert.equal("total" in second, false, "节流响应同样不暴露总量");
  const admin = await adminStats(env);
  assert.equal(admin.stats.total, 1, "节流期间 PV 不应增长");
});

test("静态资源：奶蛙头像按原字节提供，且页面确实引用它", async () => {
  const env = makeEnv({ COUNTER: mockDO() });

  const { res } = await hit(env, "/naiwa.jpg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("cache-control"), /max-age=\d+/);

  const served = Buffer.from(await res.arrayBuffer());
  const onDisk = readFileSync(resolve(HERE, "../assets/naiwa.jpg"));
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(served.length, onDisk.length, "响应字节数必须与仓库里的资源一致");
  assert.equal(sha(served), sha(onDisk), "响应字节必须与仓库里的资源逐字节一致");
  assert.ok(served.length > 5000, "头像不应该是空文件");

  const site = await openSite(env);
  assert.ok(site.html.includes('src="/naiwa.jpg"'), "页面必须引用该头像");
  assert.ok(site.html.includes('class="naiwa-img"'), "头像必须走真实素材这一层");
  assert.equal(site.html.includes("naiwa-fallback"), false, "不应再带手绘兜底青蛙");
  assert.equal(site.html.includes("naiwaSkin"), false, "兜底 SVG 的渐变定义应彻底移除");
  assert.match(site.html, /class="naiwa-img"[^>]*alt="[^"]+"/, "真图必须有 alt");
  assert.match(site.html, /class="naiwa-img"[^>]*width="512"[^>]*height="512"/, "真图应带尺寸避免布局跳动");

  // 隐藏路由纪律不能被静态资源破坏
  assert.equal((await hit(env, "/naiwa.jpg.bak")).res.status, 404);
  assert.equal((await hit(env, "/assets/naiwa.jpg")).res.status, 404, "资源只从固定公开路径提供");
});

test("邮件页：mail 子域返回入口页，转发地址必须脱敏", async () => {
  const env = makeEnv({
    COUNTER: mockDO(),
    MAIL_ZONE_LABEL: "测试中学.com",
    MAIL_FORWARD_TO: "228077668@qq.com",
    MAIL_MX_DISABLE: "1",
  });
  const res = await worker.fetch(new Request("https://mail.gateway.example/"), env, makeCtx());
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes("学校邮箱"));
  assert.ok(html.includes("测试中学.com"));
  assert.ok(html.includes("2280****68@qq.com"), "转发地址应脱敏展示");
  assert.ok(!html.includes("228077668@qq.com"), "不得暴露完整转发地址");
  assert.ok(!html.includes("{{"), "占位符必须全部替换");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(res.headers.get("content-security-policy").includes("nonce-"));

  // 普通域名不能走邮件页
  const normal = await worker.fetch(new Request("https://gateway.example/"), env, makeCtx());
  const normalHtml = await normal.text();
  assert.ok(!normalHtml.includes("学校邮箱"));
  assert.ok(normalHtml.includes("你是第"));
});

test("风采区：入口与弹窗在页面里，四张照片按原字节提供", async () => {
  const env = makeEnv({ COUNTER: mockDO() });
  const site = await openSite(env);

  // 入口与弹窗结构
  assert.ok(site.html.includes('id="gallery-open"'), "应有风采入口");
  assert.ok(site.html.includes('id="lightbox"'), "应有同页弹窗");
  assert.ok(site.html.includes("奶蛙中学风采"), "应有区块标题");
  assert.ok(site.html.includes("（可投稿）"), "标题应标注可投稿");
  assert.ok(site.html.includes("想投稿？QQ+2751404400"), "弹窗底部应有投稿 QQ");
  assert.ok(/class="lightbox-foot"/.test(site.html), "投稿信息应是小字样式");
  assert.ok(site.html.includes('aria-modal="true"'), "弹窗应具备对话框语义");
  assert.equal(/id="lightbox"[^>]*hidden/.test(site.html), true, "弹窗默认隐藏");

  // 入口在跳转按钮之后
  const ctaIdx = site.html.indexOf('id="cta"');
  const galleryIdx = site.html.indexOf('id="gallery-open"');
  assert.ok(ctaIdx > 0 && galleryIdx > ctaIdx, "风采入口必须位于跳转按钮下方");

  // 四张照片：响应字节与仓库文件逐字节一致
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const res = await hit(env, `/gallery/${n}.jpg`);
    assert.equal(res.res.status, 200, `/gallery/${n}.jpg 应可访问`);
    assert.equal(res.res.headers.get("content-type"), "image/jpeg");
    assert.match(res.res.headers.get("cache-control"), /max-age=\d+/);
    const served = Buffer.from(await res.res.arrayBuffer());
    const onDisk = readFileSync(resolve(HERE, `../assets/gallery/${n}.jpg`));
    assert.equal(sha(served), sha(onDisk), `/gallery/${n}.jpg 字节必须一致`);
    assert.ok(site.html.includes(`/gallery/${n}.jpg`), `页面应引用第 ${n} 张`);
  }

  assert.equal((await hit(env, "/gallery/7.jpg")).res.status, 404, "越界编号应 404");
  assert.equal((await hit(env, "/gallery/1.png")).res.status, 404);
});

test("配色：四套主题可选，切换按钮在右上角且默认跟随黑", async () => {
  const env = makeEnv({ COUNTER: mockDO() });
  const site = await openSite(env);
  const html = site.html;

  // 四套主题的 CSS 与菜单项
  for (const name of ["graphite", "red", "avocado"]) {
    assert.ok(html.includes(`:root[data-theme="${name}"]`), `应有 ${name} 主题变量`);
  }
  assert.ok(html.includes(':root, :root[data-theme="noir"]'), "黑应为默认主题");
  const options = [...html.matchAll(/data-theme-opt="([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(options, ["avocado", "graphite", "noir", "red"], "菜单应有四个选项");

  // 切换按钮与菜单语义
  assert.ok(html.includes('id="theme-btn"'), "应有切换按钮");
  assert.ok(/id="theme-btn"[^>]*aria-haspopup="true"/.test(html), "按钮应声明弹出行为");
  assert.ok(/id="theme-menu"[^>]*hidden/.test(html), "菜单默认收起");

  // 浅色主题不能残留写死的白字/黑底关键项
  assert.ok(html.includes("var(--btn-bg)") && html.includes("var(--btn-fg)"), "按钮颜色必须走变量");
  assert.ok(html.includes("var(--panel)") && html.includes("var(--scrim)"), "弹窗底色与遮罩必须走变量");
  assert.ok(html.includes("var(--light)"), "主光必须走变量");
  assert.ok(!/color: #0a0a0c/.test(html), "按钮文字色不得写死在规则里");
  assert.ok(!/background: #08080a/.test(html), "弹窗底色不得写死在规则里");

  // 首屏前应用已保存主题的脚本，必须带 nonce
  assert.ok(/<script nonce="[^"]+">[\s\S]{0,200}vg-theme/.test(html), "应有 pre-paint 主题脚本且带 nonce");

  // 右上角容器仍在
  assert.ok(html.includes('class="corner"'));
  const cornerIdx = html.indexOf('class="corner"');
  const themeIdx = html.indexOf('id="theme-btn"');
  assert.ok(themeIdx > cornerIdx, "切换按钮必须在右上角容器内");
});

/* ------------------------------------------------------------------ 运行 */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    const where = (error.stack || "").split("\n").slice(1, 3).join("\n      ");
    console.log(`      ${error.message}\n      ${where.replace(/^ {4}/gm, "")}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
