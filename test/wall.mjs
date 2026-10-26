/** 留言墙 / 上传 / 管理台 的测试（不需要真 DO：用最小 stub 覆盖校验与鉴权分支）。 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./html-loader.mjs", import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");



const SECRET_W = "wall-fixture-alpha";
const ADMIN_W = "wall-fixture-token";

/** Vault 的最小 stub：只回固定结构，够覆盖路由分支 */
function vaultStub(handler) {
  return {
    idFromName: () => "stub",
    get: () => ({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = init && init.body ? JSON.parse(init.body) : {};
        const out = handler(path, body, init && init.method);
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
}

/** KV 的最小 stub */
function kvStub() {
  const map = new Map();
  return {
    map,
    put: async (k, v, opts) => map.set(k, { v, metadata: (opts && opts.metadata) || {} }),
    get: async (k) => (map.has(k) ? map.get(k).v : null),
    getWithMetadata: async (k) => (map.has(k) ? { value: map.get(k).v, metadata: map.get(k).metadata } : null),
    delete: async (k) => map.delete(k),
  };
}

const worker = (await import("../src/index.js")).default;

const makeCtx = () => ({ waitUntil() {}, passThroughOnException() {} });

function env(extra = {}) {
  return { API_SECRET: SECRET_W, ADMIN_TOKEN: ADMIN_W, TARGET_URL: "https://www.yzzx.org", TZ_OFFSET: "8", ...extra };
}

const call = (path, init = {}, e = env()) =>
  worker.fetch(new Request(`https://gateway.example${path}`, init), e, makeCtx());

const post = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const results = [];
async function it(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, name, err.message]);
  }
}

/* ------------------------------------------------------------------ 用例 */

await it("管理台：/admin 返回页面，且带 noindex", async () => {
  const res = await call("/admin");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("x-robots-tag") || "", /noindex/);
  const html = await res.text();
  assert.ok(html.includes("管理台"));
  assert.ok(html.includes("passkey"));
  assert.ok(html.includes('id="next-action"'), "应有「现在该做」这一行");
  assert.ok(html.includes("await register(true)"), "令牌通过后应自动继续绑定");
  assert.ok(!/id="btn-register"[^>]*disabled/.test(html), "绑定按钮不应被禁用");
});

await it("管理台接口：未登录时 session 为 false、list 为 401", async () => {
  const s = await call("/admin/api/session");
  assert.equal(s.status, 200);
  const data = await s.json();
  assert.equal(data.authed, false);

  const l = await call("/admin/api/list");
  assert.equal(l.status, 401);
});

await it("管理台接口：没有令牌不能取注册 challenge（403）", async () => {
  const res = await call("/admin/api/passkey/options", post({ mode: "register" }));
  assert.equal(res.status, 403);
});

await it("管理台接口：令牌正确时返回合规的 WebAuthn 注册参数", async () => {
  const res = await call("/admin/api/passkey/options", post({ mode: "register" }, { "x-admin-token": ADMIN_W }));
  assert.equal(res.status, 200);
  const data = await res.json();
  const pk = data.publicKey;
  assert.ok(pk.challenge && typeof pk.challenge === "string", "应有 challenge");
  assert.equal(pk.rp.id, "gateway.example");
  assert.ok(pk.pubKeyCredParams.some((p) => p.alg === -7), "应支持 ES256");
  assert.equal(pk.attestation, "none");
  assert.match(res.headers.get("set-cookie") || "", /vw-chal=/);
});

await it("管理台接口：令牌错误时拒绝", async () => {
  const res = await call("/admin/api/token", post({ token: "wrong" }));
  assert.equal(res.status, 403);
});

await it("留言墙：未绑定 Vault 时 enabled=false 且写入返回 503", async () => {
  const res = await call("/api/wall");
  const data = await res.json();
  assert.equal(data.enabled, false);
  assert.deepEqual(data.danmaku, []);

  const w = await call("/api/wall/danmaku", post({ text: "hi" }));
  assert.equal(w.status, 503);
});

await it("留言墙：绑定后能写入并读出，颜色/字号被规范化", async () => {
  const seen = [];
  const e = env({
    VAULT: vaultStub((path, body) => {
      if (path === "/danmaku" && body.text !== undefined) {
        seen.push(body);
        return { ok: true, item: { id: "abc", text: body.text, color: "#ffd166", size: 15, created: 1 } };
      }
      if (path === "/danmaku") return { items: [{ id: "abc", text: "hi", color: "#ffd166", size: 15, created: 1 }] };
      return { items: [] };
    }),
  });

  const w = await call("/api/wall/danmaku", { ...post({ text: "  奶蛙在吗  ", color: "#FFD166", size: 999 }), headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" } }, e);
  assert.equal(w.status, 201);
  const body = await w.json();
  assert.ok(body.item.id);

  const list = await call("/api/wall", {}, e);
  const data = await list.json();
  assert.equal(data.enabled, true);
  assert.equal(data.danmaku.length, 1);
});

await it("上传：非图片被拒（415），超 10MB 被拒（413）", async () => {
  const e = env({
    VAULT: vaultStub(() => ({ ok: true, item: { id: "abcdefabcdefabcd" } })),
    UPLOADS: kvStub(),
  });

  const notImage = await call(
    "/api/wall/upload",
    { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3, 4]) },
    e,
  );
  assert.equal(notImage.status, 415);

  const tooBig = await call(
    "/api/wall/upload",
    { method: "POST", headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) }, body: new Uint8Array(8) },
    e,
  );
  assert.equal(tooBig.status, 413);
});

await it("上传：真 PNG 能存进 KV 并能按原字节取回", async () => {
  const kv = kvStub();
  const e = env({
    VAULT: vaultStub(() => ({ ok: true, item: { id: "x" } })),
    UPLOADS: kv,
  });
  const png = readFileSync(resolve(ROOT, "assets/favicon.png"));
  const res = await call(
    "/api/wall/upload",
    { method: "POST", headers: { "content-type": "image/png" }, body: png },
    e,
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.item.mime, "image/png");

  const got = await call(`/img/${data.item.id}`, {}, e);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  const back = Buffer.from(await got.arrayBuffer());
  assert.equal(back.length, png.length);
  assert.equal(back.subarray(0, 4).toString("hex"), "89504e47");
});

await it("取图：非法 id 与不存在的 id 都是 404", async () => {
  const e = env({ VAULT: vaultStub(() => ({ items: [] })), UPLOADS: kvStub() });
  assert.equal((await call("/img/short", {}, e)).status, 404);
  assert.equal((await call("/img/aaaaaaaaaaaaaaaaaaaa", {}, e)).status, 404);
});

await it("webauthn：DER 签名转 raw 后长度正确、CBOR 能解出 COSE 结构", async () => {
  const { derToRaw, cborDecode, coseToKey, b64uEncode, b64uDecode } = await import("../src/webauthn.js");

  // 一个 DER 序列：两个 32 字节整数（其中一个带前导 0）
  const r = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(31, 0x11)]);
  const s = Buffer.alloc(32, 0x22);
  const der = Buffer.concat([Buffer.from([0x30, 0x46, 0x02, 0x20]), r, Buffer.from([0x02, 0x20]), s]);
  const raw = derToRaw(new Uint8Array(der));
  assert.equal(raw.length, 64, "raw 必须是 64 字节");

  // COSE: {1:2, 3:-7, -1:1, -2:<32B>, -3:<32B>}
  const x = Buffer.alloc(32, 0xaa);
  const y = Buffer.alloc(32, 0xbb);
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const decoded = cborDecode(new Uint8Array(cose));
  const key = coseToKey(decoded);
  assert.equal(key.alg, -7);
  assert.equal(key.jwk.kty, "EC");
  assert.equal(b64uDecode(key.jwk.x).length, 32);

  // base64url 往返
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  assert.deepEqual([...b64uDecode(b64uEncode(bytes))], [...bytes]);
});

await it("黑名单：被拦截的 IP 上传返回 403，且 KV 不残留", async () => {
  const kv = kvStub();
  const e = env({
    VAULT: vaultStub((path) => (path === "/upload" ? { error: "该 IP 已被限制上传", blocked: true } : { items: [] })),
    UPLOADS: kv,
  });
  // vaultStub 固定返回 200，这里改成 403 需要自定义
  const e2 = {
    ...e,
    VAULT: {
      idFromName: () => "stub",
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ error: "该 IP 已被限制上传", blocked: true }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      }),
    },
  };
  const png = readFileSync(resolve(ROOT, "assets/favicon.png"));
  const res = await call("/api/wall/upload", { method: "POST", headers: { "content-type": "image/png" }, body: png }, e2);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.blocked, true);
  assert.ok(/限制上传/.test(data.error));
  assert.equal(kv.map.size, 0, "被拒绝时不应在 KV 留下图片");
});

await it("指纹：上传与弹幕都会把 x-bfp / x-dfp 传给 Vault", async () => {
  const seen = [];
  const e = env({
    VAULT: vaultStub((path, body) => {
      seen.push({ path, body });
      return path === "/upload" ? { ok: true, item: { id: "abcdefabcdefabcd" } } : { ok: true, item: { id: "abc", text: "x", color: "#fff", size: 15, created: 1 } };
    }),
    UPLOADS: kvStub(),
  });

  const png = readFileSync(resolve(ROOT, "assets/favicon.png"));
  await call("/api/wall/upload", {
    method: "POST",
    headers: { "content-type": "image/png", "x-bfp": "1111aaaa", "x-dfp": "2222bbbb", "cf-connecting-ip": "9.9.9.9" },
    body: png,
  }, e);

  await call("/api/wall/danmaku", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bfp": "3333cccc", "x-dfp": "4444dddd", "cf-connecting-ip": "9.9.9.9" },
    body: JSON.stringify({ text: "hi", color: "#ffffff", size: 15 }),
  }, e);

  const up = seen.find((s) => s.path === "/upload");
  const dm = seen.find((s) => s.path === "/danmaku");
  assert.equal(up.body.bfp, "1111aaaa");
  assert.equal(up.body.dfp, "2222bbbb");
  assert.equal(up.body.ip, "9.9.9.9");
  assert.equal(dm.body.bfp, "3333cccc");
  assert.equal(dm.body.dfp, "4444dddd");
  assert.equal(dm.body.ip, "9.9.9.9");
});

await it("黑名单：管理接口未登录一律 401", async () => {
  const e = env({ VAULT: vaultStub(() => ({ items: [] })) });
  assert.equal((await call("/admin/api/blocks", {}, e)).status, 401);
  const post = await call("/admin/api/block", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ip: "1.2.3.4" }) }, e);
  assert.equal(post.status, 401);
});

await it("黑名单：被限制的 IP 发弹幕也返回 403", async () => {
  const e = {
    ...env(),
    VAULT: {
      idFromName: () => "stub",
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ error: "该网络已被限制发送，如有疑问可联系管理员", blocked: true }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      }),
    },
  };
  const res = await call(
    "/api/wall/danmaku",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "5.6.7.8" },
      body: JSON.stringify({ text: "hi", color: "#ffffff", size: 15 }),
    },
    e,
  );
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.blocked, true);
  assert.ok(/限制发送/.test(data.error));
});

await it("站长私信：公开投递返回查询码，按码可取回回复", async () => {
  let stored = null;
  const e = env({
    VAULT: vaultStub((path, body) => {
      if (path === "/message") {
        stored = { code: "abc1234567", body: body.body, reply: "", replied: 0 };
        return { ok: true, id: "m1", code: "abc1234567" };
      }
      if (path === "/message") return { item: null };
      return { items: [] };
    }),
  });

  // 改写 stub：GET /message 走查询码分支
  e.VAULT = {
    idFromName: () => "stub",
    get: () => ({
      fetch: async (url, init) => {
        const u = new URL(url);
        const path = u.pathname;
        const body = init && init.body ? JSON.parse(init.body) : {};
        let out;
        if (path === "/message" && init && init.method === "POST") {
          out = { ok: true, id: "m1", code: "abc1234567" };
        } else if (path === "/message" && u.searchParams.get("code") === "abc1234567") {
          out = { item: { body: "希望加个夜间模式", reply: "收到，已排期", replied: 1, created: 1 } };
        } else {
          out = { error: "not found" };
        }
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };

  const post = await call(
    "/api/wall/message",
    { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "7.7.7.7" }, body: JSON.stringify({ name: "小王", body: "希望加个夜间模式" }) },
    e,
  );
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.match(created.code, /^[a-f0-9]{10}$/);

  const got = await call(`/api/wall/message?code=${created.code}`, {}, e);
  assert.equal(got.status, 200);
  const item = (await got.json()).item;
  assert.equal(item.replied, 1);
  assert.ok(item.reply.length > 0);

  const bad = await call("/api/wall/message?code=nope", {}, e);
  assert.equal(bad.status, 400, "查询码格式不对应 400");
});

await it("站长私信：管理接口未登录 401", async () => {
  const e = env({ VAULT: vaultStub(() => ({ items: [] })) });
  assert.equal((await call("/admin/api/messages", {}, e)).status, 401);
  const r = await call(
    "/admin/api/message/reply",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "m1", reply: "ok" }) },
    e,
  );
  assert.equal(r.status, 401);
});

await it("会话接口不向匿名者泄露 passkey 明细（只回数量）", async () => {
  const e = env({
    VAULT: vaultStub((path) => {
      if (path === "/passkeys") return { items: [{ id: "cred1", name: "Mozilla/5.0 Secret-UA", created: 1 }] };
      return { items: [] };
    }),
  });
  const res = await call("/admin/api/session", {}, e);
  const data = await res.json();
  assert.equal(data.authed, false);
  assert.equal(data.passkeyCount, 1, "应返回数量");
  assert.deepEqual(data.passkeys, [], "匿名时不得返回凭据名称");
  assert.equal(JSON.stringify(data).includes("Mozilla"), false);
});

await it("上传：像素炸弹（30000x30000 PNG）被拒 413", async () => {
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(30000, 16);
  png.writeUInt32BE(30000, 20);
  const e = env({ VAULT: vaultStub(() => ({ ok: true, item: { id: "x" } })), UPLOADS: kvStub() });
  const res = await call("/api/wall/upload", { method: "POST", headers: { "content-type": "image/png" }, body: png }, e);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /过大/);
});

await it("IP 归一化：IPv4 映射的 IPv6 与 IPv4 视为同一来源", async () => {
  const { normIp } = await import("../src/vault.js");
  assert.equal(normIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normIp("::FFFF:203.0.113.9"), "203.0.113.9");
  assert.equal(normIp("  203.0.113.9  "), "203.0.113.9");
  assert.equal(normIp("2001:DB8::1"), "2001:db8::1");
});

await it("管理写接口拒绝跨站 Origin", async () => {
  const e = env({ VAULT: vaultStub(() => ({ items: [] })) });
  const res = await call(
    "/admin/api/block",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ ip: "1.2.3.4" }),
    },
    e,
  );
  assert.equal(res.status, 403, "跨站写请求应被拒");
  assert.match((await res.json()).error, /跨站/);
});


await it("上传：WebP(VP8L) 声明超大尺寸同样被拒（换子格式不能绕过像素上限）", async () => {
  const buf = Buffer.alloc(40);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  buf[20] = 0x2f;
  const w = 15999;
  const h = 15999;
  buf[21] = w & 0xff;
  buf[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  buf[23] = (h >> 2) & 0xff;
  buf[24] = (h >> 10) & 0x0f;
  const e = env({ VAULT: vaultStub(() => ({ ok: true, item: { id: "x" } })), UPLOADS: kvStub() });
  const res = await call(
    "/api/wall/upload",
    { method: "POST", headers: { "content-type": "image/webp" }, body: buf },
    e,
  );
  assert.equal(res.status, 413, "VP8L 大图应被拒");
});

await it("私信：查询码为 16 位十六进制（8 字节随机）", async () => {
  const e = env({ VAULT: vaultStub(() => ({ ok: true, id: "m", code: "aabbccdd00112233" })) });
  const res = await call(
    "/api/wall/message",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }) },
    e,
  );
  assert.equal(res.status, 201);
  assert.match((await res.json()).code, /^[a-f0-9]{16}$/);
});

await it("未配置 API_SECRET 时拒绝签发管理会话", async () => {
  const e = { ...env(), API_SECRET: "", VAULT: vaultStub(() => ({ items: [] })) };
  const res = await call(
    "/admin/api/passkey/options",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "login" }) },
    e,
  );
  assert.equal(res.status, 503, "空密钥应直接 503");
});

/* ------------------------------------------------------------------ 汇总 */

let pass = 0;
for (const [ok, name, msg] of results) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : "  →  " + msg}`);
  if (ok) pass += 1;
}
console.log(`\n${pass}/${results.length} 通过`);
process.exitCode = pass === results.length ? 0 : 1;
