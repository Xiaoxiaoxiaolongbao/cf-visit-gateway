/**
 * 留言（弹幕）/ 图片上传 / passkey 会话 / 管理接口。
 *
 * 设计上的几条硬约束：
 *   - 公开写入口只做「限流 + 长度/类型白名单」，其他一律拒绝，不回显内部错误
 *   - 图片字节进 KV（25MB/值），元信息进 Vault DO；单张上限 10MB，按魔数判定真实类型
 *   - 管理鉴权两条路：passkey 会话，或 x-admin-token（用于首次注册 passkey 的引导）
 *   - 会话与 challenge 都用 HMAC 签名的 Cookie，天然无状态，重启不丢
 */

import ADMIN_HTML from "./admin.html";
import { b64uEncode, b64uDecode, verifyRegistration, verifyAssertion } from "./webauthn.js";

const MAX_UPLOAD = 10 * 1024 * 1024;
const SESSION_TTL = 12 * 3600 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const BOOTSTRAP_TTL = 30 * 60 * 1000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const notFound = () => new Response(null, { status: 404 });

/* ------------------------------------------------------------ 基础工具 */

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret || "insecure-default-salt"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function sign(secret, payload) {
  const body = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = b64uEncode(await hmac(secret, body));
  return `${body}.${mac}`;
}

async function unsign(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = b64uEncode(await hmac(secret, body));
  if (mac !== expect) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

function setCookie(name, value, maxAge, extra = "") {
  return `${name}=${value}; Path=/; Max-Age=${Math.floor(maxAge / 1000)}; HttpOnly; Secure; SameSite=${extra || "Lax"}`;
}

export function randomId(bytes = 16) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* --------------------------------------------------------- Vault 访问 */

function vault(env) {
  const ns = env && env.VAULT;
  if (!ns) return null;
  return ns.get(ns.idFromName("vault-v1"));
}

async function vaultCall(env, path, init) {
  const stub = vault(env);
  if (!stub) return null;
  const res = await stub.fetch(`https://vault.internal${path}`, init);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const vaultPost = (env, path, body) =>
  vaultCall(env, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* ----------------------------------------------------------- 鉴权 */

function rpDomain(url) {
  return url.hostname.replace(/^www\./, "");
}

function allowedOrigins(url) {
  const bare = rpDomain(url);
  const port = url.port ? `:${url.port}` : "";
  return new Set([`${url.protocol}//${bare}${port}`, `${url.protocol}//www.${bare}${port}`]);
}

async function isAuthed(request, url, cfg) {
  if (!cfg || !cfg.apiSecret) return false;
  const sess = await unsign(cfg.apiSecret, cookie(request, "vw-sess"));
  return Boolean(sess && sess.role === "admin");
}

function hasAdminToken(request, cfg) {
  const token = request.headers.get("x-admin-token") || "";
  return Boolean(cfg && cfg.adminToken && token && token === cfg.adminToken);
}

/** 令牌只在「一条 passkey 都没有」时可用；绑定过之后它就不再是入口 */
async function tokenUsable(env, request, cfg) {
  if (!hasAdminToken(request, cfg)) return false;
  const list = (await vaultCall(env, "/passkeys")) || { items: [] };
  return (list.items || []).length === 0;
}

/* ------------------------------------------------------------ 公开读 */

export async function handleWallGet(env) {
  const [danmaku, uploads] = await Promise.all([
    vaultCall(env, "/danmaku?limit=80"),
    vaultCall(env, "/uploads?limit=60"),
  ]);
  return json({
    danmaku: (danmaku && danmaku.items) || [],
    uploads: (uploads && uploads.items) || [],
    enabled: Boolean(vault(env)),
  });
}

/* ------------------------------------------------------------ 发弹幕 */

export async function handleDanmakuPost(request, env, url, cfg) {
  if (!vault(env)) return json({ error: "留言未启用" }, 503);

  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) return json({ error: "内容太长" }, 413);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "格式错误" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const iphash = await sha256Hex(`${ip}|${cfg.apiSecret || ""}`);

  const fp = fingerprintsOf(request);
  const rec = await vaultRaw(env, "/danmaku", {
    text: body.text,
    color: body.color,
    size: body.size,
    iphash,
    ip,
    bfp: fp.bfp,
    dfp: fp.dfp,
  });
  if (rec.status !== 200 || !rec.data || rec.data.error) {
    const code = rec.status === 403 ? 403 : rec.status === 429 ? 429 : 400;
    return json({ error: (rec.data && rec.data.error) || "写入失败", blocked: code === 403 }, code);
  }
  return json({ ok: true, item: rec.data.item }, 201);
}

/* ------------------------------------------------------------ 传图片 */

const MAGIC = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mime: "image/webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
  },
];

export async function handleUploadPost(request, env, url, cfg) {
  if (!vault(env)) return json({ error: "上传未启用" }, 503);
  if (!env.UPLOADS) return json({ error: "存储未绑定" }, 503);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD) return json({ error: "超过 10MB" }, 413);

  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return json({ error: "空文件" }, 400);
  if (buf.length > MAX_UPLOAD) return json({ error: "超过 10MB" }, 413);

  const kind = MAGIC.find((m) => m.test(buf));
  if (!kind) return json({ error: "只接受 JPG / PNG / GIF / WebP" }, 415);

  const id = randomId(10);
  const title = String(url.searchParams.get("title") || "").slice(0, 60);

  await env.UPLOADS.put(`img:${id}`, buf, {
    metadata: { mime: kind.mime, bytes: buf.length, created: Date.now() },
  });

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const iphash = await sha256Hex(`${ip}|${cfg.apiSecret || ""}`);
  const fp = fingerprintsOf(request);
  const rec = await vaultRaw(env, "/upload", {
    id,
    mime: kind.mime,
    bytes: buf.length,
    iphash,
    title,
    ip,
    bfp: fp.bfp,
    dfp: fp.dfp,
  });

  if (rec.status !== 200 || !rec.data || rec.data.error) {
    await env.UPLOADS.delete(`img:${id}`);
    const code = rec.status === 403 ? 403 : rec.status === 429 ? 429 : 500;
    return json({ error: (rec.data && rec.data.error) || "记录失败", blocked: code === 403 }, code);
  }
  return json({ ok: true, item: { id, mime: kind.mime, bytes: buf.length, title } }, 201);
}

/* ------------------------------------------------------- 站长私信 */

const MESSAGE_LIMIT = 500;

export async function handleMessagePost(request, env, url, cfg) {
  if (!vault(env)) return json({ error: "留言未启用" }, 503);
  if (Number(request.headers.get("content-length") || 0) > 8192) return json({ error: "内容太长" }, 413);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "格式错误" }, 400);
  if (String(body.body || "").trim().length > MESSAGE_LIMIT) return json({ error: `超过 ${MESSAGE_LIMIT} 字` }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const iphash = await sha256Hex(`${ip}|${cfg.apiSecret || ""}`);
  const fp = fingerprintsOf(request);

  const rec = await vaultRaw(env, "/message", {
    name: body.name,
    contact: body.contact,
    body: body.body,
    ip,
    iphash,
    bfp: fp.bfp,
    dfp: fp.dfp,
  });
  if (rec.status !== 200 || !rec.data || rec.data.error) {
    const code = rec.status === 403 ? 403 : rec.status === 429 ? 429 : 400;
    return json({ error: (rec.data && rec.data.error) || "提交失败", blocked: code === 403 }, code);
  }
  return json({ ok: true, code: rec.data.code }, 201);
}

export async function handleMessageLookup(env, url) {
  const code = String(url.searchParams.get("code") || "").trim();
  if (!/^[a-f0-9]{10}$/i.test(code)) return json({ error: "查询码格式不对" }, 400);
  const got = await vaultCall(env, `/message?code=${encodeURIComponent(code)}`);
  if (!got || !got.item) return json({ error: "没有找到这条留言" }, 404);
  return json({ item: got.item });
}

/* ------------------------------------------------------------ 取图片 */

export async function handleImageGet(env, url, id) {
  if (!env.UPLOADS) return notFound();
  if (!/^[a-z0-9]{16,32}$/.test(id)) return notFound();
  const got = await env.UPLOADS.getWithMetadata(`img:${id}`, { type: "arrayBuffer" });
  if (!got || !got.value) return notFound();
  const meta = got.metadata || {};
  return new Response(got.value, {
    headers: {
      "content-type": meta.mime || "application/octet-stream",
      "content-length": String(got.value.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/* ------------------------------------------------------------- /admin */

export function handleAdminPage() {
  const nonce = randomId(16);
  const html = ADMIN_HTML.replaceAll("{{NONCE}}", nonce);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

export async function handleAdminApi(request, env, url, cfg) {
  const path = url.pathname.replace(/^\/admin\/api/, "");
  const authed = await isAuthed(request, url, cfg);
  const tokenOk = hasAdminToken(request, cfg);
  const rpId = rpDomain(url);
  const origin = url.origin;

  /* --- 会话状态 --- */
  if (path === "/session" && request.method === "GET") {
    const passkeys = (await vaultCall(env, "/passkeys")) || { items: [] };
    return json({
      authed,
      tokenOk,
      rpId,
      host: url.hostname,
      origin,
      passkeys: passkeys.items || [],
      vault: Boolean(vault(env)),
      uploads: Boolean(env.UPLOADS),
    });
  }

  /* --- 注册 / 登录：第一步发 challenge --- */
  if (path === "/passkey/options" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "register" ? "register" : "login";

    if (mode === "register" && !authed) {
      if (!(await tokenUsable(env, request, cfg))) {
        return json({ error: "已存在 passkey：绑定新设备请先用这台电脑的 passkey 登录，令牌通道已关闭" }, 403);
      }
    }

    const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const cookieVal = await sign(cfg.apiSecret, { c: challenge, exp: Date.now() + CHALLENGE_TTL, mode });
    const headers = { "set-cookie": setCookie("vw-chal", cookieVal, CHALLENGE_TTL) };

    if (mode === "register") {
      return json(
        {
          publicKey: {
            challenge,
            rp: { id: rpId, name: "奶蛙中学 · 留言板" },
            user: { id: b64uEncode(crypto.getRandomValues(new Uint8Array(16))), name: "admin", displayName: "管理员" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            timeout: 60000,
            attestation: "none",
            authenticatorSelection: {
              authenticatorAttachment: "platform",
              residentKey: "preferred",
              userVerification: "required",
            },
          },
        },
        200,
        headers,
      );
    }

    const list = (await vaultCall(env, "/passkeys")) || { items: [] };
    if (!(list.items || []).length) {
      return json({ error: "这台电脑还没有绑定的 passkey，请先完成第 2 步绑定" }, 409);
    }
    return json(
      {
        publicKey: {
          challenge,
          rpId,
          timeout: 60000,
          userVerification: "preferred",
          allowCredentials: (list.items || []).map((k) => ({ type: "public-key", id: k.id })),
        },
      },
      200,
      headers,
    );
  }

  /* --- 注册：校验并落库 --- */
  if (path === "/passkey/register" && request.method === "POST") {
    if (!authed && !(await tokenUsable(env, request, cfg))) {
      return json({ error: "已存在 passkey：请先用 passkey 登录后再绑定新设备" }, 403);
    }
    const body = await request.json().catch(() => ({}));
    const chal = await unsign(cfg.apiSecret, cookie(request, "vw-chal"));
    if (!chal || chal.mode !== "register") return json({ error: "挑战已失效，请重试" }, 400);

    try {
      const reg = await verifyRegistration({
        payload: body.response || {},
        challenge: chal.c,
        origin,
        rpId,
      });
      const stored = await vaultPost(env, "/passkey", {
        id: reg.credentialId,
        jwk: reg.jwk,
        alg: reg.alg,
        signCount: reg.signCount,
        name: String(body.name || "").slice(0, 40),
      });
      if (!stored || !stored.ok) return json({ error: "保存凭据失败：Vault 未就绪" }, 500);
      const sess = await sign(cfg.apiSecret, { role: "admin", exp: Date.now() + SESSION_TTL });
      return json({ ok: true, credentialId: reg.credentialId }, 200, {
        "set-cookie": setCookie("vw-sess", sess, SESSION_TTL),
      });
    } catch (err) {
      return json({ error: String(err.message || err) }, 400);
    }
  }

  /* --- 登录：校验签名 --- */
  if (path === "/passkey/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const chal = await unsign(cfg.apiSecret, cookie(request, "vw-chal"));
    if (!chal || chal.mode !== "login") return json({ error: "挑战已失效，请重试" }, 400);

    const id = String(body.id || "");
    const rec = await vaultCall(env, `/passkey?id=${encodeURIComponent(id)}`);
    const key = rec && rec.item;
    if (!key) return json({ error: "这台设备上还没有注册过的 passkey" }, 404);

    try {
      const res = await verifyAssertion({
        payload: body.response || {},
        challenge: chal.c,
        origin,
        rpId,
        jwk: JSON.parse(key.jwk),
        alg: key.alg,
      });
      await vaultPost(env, "/passkey/counter", { id, signCount: res.signCount });
      const sess = await sign(cfg.apiSecret, { role: "admin", exp: Date.now() + SESSION_TTL });
      return json({ ok: true }, 200, { "set-cookie": setCookie("vw-sess", sess, SESSION_TTL) });
    } catch (err) {
      return json({ error: String(err.message || err) }, 400);
    }
  }

  /* --- 令牌引导：验证令牌后种一个短期会话，仅用于注册首个 passkey --- */
  if (path === "/token" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || "");
    if (!cfg.adminToken || token !== cfg.adminToken) return json({ error: "令牌不正确" }, 403);
    const existing = (await vaultCall(env, "/passkeys")) || { items: [] };
    if ((existing.items || []).length > 0) {
      return json({ error: "已有 passkey，令牌通道已关闭；请直接用 passkey 登录" }, 403);
    }
    const sess = await sign(cfg.apiSecret, { role: "admin", exp: Date.now() + BOOTSTRAP_TTL });
    return json({ ok: true, ttl: BOOTSTRAP_TTL }, 200, { "set-cookie": setCookie("vw-sess", sess, BOOTSTRAP_TTL) });
  }

  /* --- 以下要求已登录：passkey 会话（令牌仅在无 passkey 时可用） --- */
  if (!authed && !(await tokenUsable(env, request, cfg))) return json({ error: "未登录" }, 401);

  if (path === "/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": setCookie("vw-sess", "", 1) });
  }

  if (path === "/list" && request.method === "GET") {
    const [danmaku, uploads] = await Promise.all([
      vaultCall(env, "/danmaku?limit=200&all=1"),
      vaultCall(env, "/uploads?limit=200&all=1"),
    ]);
    return json({ danmaku: (danmaku && danmaku.items) || [], uploads: (uploads && uploads.items) || [] });
  }

  if (path === "/delete" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!id) return json({ error: "缺少 id" }, 400);
    if (body.kind === "danmaku") {
      await vaultPost(env, "/danmaku/remove", { id });
      return json({ ok: true });
    }
    if (body.kind === "message") {
      await vaultPost(env, "/messages/remove", { id });
      return json({ ok: true });
    }
    if (body.kind === "upload") {
      await vaultPost(env, "/uploads/remove", { id });
      if (env.UPLOADS) await env.UPLOADS.delete(`img:${id}`);
      return json({ ok: true });
    }
    return json({ error: "kind 非法" }, 400);
  }

  if (path === "/messages" && request.method === "GET") {
    const list = (await vaultCall(env, "/messages?limit=200")) || { items: [] };
    return json({ items: list.items || [] });
  }

  if (path === "/message/reply" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!id) return json({ error: "缺少 id" }, 400);
    await vaultPost(env, "/messages/reply", { id, reply: String(body.reply || "").slice(0, MESSAGE_LIMIT) });
    return json({ ok: true });
  }

  if (path === "/blocks" && request.method === "GET") {
    const list = (await vaultCall(env, "/blocks")) || { items: [] };
    return json({ items: list.items || [] });
  }

  if (path === "/block" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const ip = String(body.ip || "").slice(0, 45);
    if (!ip) return json({ error: "缺少 IP" }, 400);
    await vaultPost(env, "/block", { ip, reason: String(body.reason || "").slice(0, 80) });
    return json({ ok: true, ip });
  }

  if (path === "/unblock" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const ip = String(body.ip || "").slice(0, 45);
    if (!ip) return json({ error: "缺少 IP" }, 400);
    await vaultPost(env, "/unblock", { ip });
    return json({ ok: true, ip });
  }

  if (path === "/passkey/remove" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await vaultPost(env, "/passkey/remove", { id: String(body.id || "") });
    return json({ ok: true });
  }

  return notFound();
}

/* -------------------------------- 追加：指纹与原始返回（函数声明会提升） */

/** 需要区分状态码时用这个：黑名单拦截回 403，要如实告诉前端 */
async function vaultRaw(env, path, body) {
  const stub = vault(env);
  if (!stub) return { status: 503, data: { error: "Vault 未就绪" } };
  const res = await stub.fetch("https://vault.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** 客户端算的两枚指纹：bfp=浏览器、dfp=设备；只校验格式，不参与拦截 */
function fingerprintsOf(request) {
  const ok = (v) => (/^[a-f0-9]{8,32}$/i.test(v || "") ? v.toLowerCase() : "");
  return {
    bfp: ok(request.headers.get("x-bfp") || ""),
    dfp: ok(request.headers.get("x-dfp") || ""),
  };
}
