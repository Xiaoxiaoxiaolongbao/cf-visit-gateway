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

  const res = await vaultPost(env, "/danmaku", {
    text: body.text,
    color: body.color,
    size: body.size,
    iphash,
  });
  if (!res) return json({ error: "写入失败" }, 500);
  if (res.error) return json({ error: res.error }, res.error.includes("太快") ? 429 : 400);
  return json({ ok: true, item: res.item }, 201);
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
  const rec = await vaultPost(env, "/upload", { id, mime: kind.mime, bytes: buf.length, iphash, title });

  if (!rec || rec.error) {
    await env.UPLOADS.delete(`img:${id}`);
    return json({ error: (rec && rec.error) || "记录失败" }, 429);
  }
  return json({ ok: true, item: { id, mime: kind.mime, bytes: buf.length, title } }, 201);
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
      passkeys: passkeys.items || [],
      vault: Boolean(vault(env)),
    });
  }

  /* --- 注册 / 登录：第一步发 challenge --- */
  if (path === "/passkey/options" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "register" ? "register" : "login";

    if (mode === "register" && !authed && !tokenOk) return json({ error: "需要先通过令牌验证" }, 403);

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
            authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          },
        },
        200,
        headers,
      );
    }

    const list = (await vaultCall(env, "/passkeys")) || { items: [] };
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
    if (!authed && !tokenOk) return json({ error: "需要先通过令牌验证" }, 403);
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
      await vaultPost(env, "/passkey", {
        id: reg.credentialId,
        jwk: reg.jwk,
        alg: reg.alg,
        signCount: reg.signCount,
        name: String(body.name || "").slice(0, 40),
      });
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
    const sess = await sign(cfg.apiSecret, { role: "admin", exp: Date.now() + CHALLENGE_TTL });
    return json({ ok: true }, 200, { "set-cookie": setCookie("vw-sess", sess, CHALLENGE_TTL) });
  }

  /* --- 以下要求已登录（passkey 会话，或管理令牌） --- */
  if (!authed && !tokenOk) return json({ error: "未登录" }, 401);

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
    if (body.kind === "upload") {
      await vaultPost(env, "/uploads/remove", { id });
      if (env.UPLOADS) await env.UPLOADS.delete(`img:${id}`);
      return json({ ok: true });
    }
    return json({ error: "kind 非法" }, 400);
  }

  if (path === "/passkey/remove" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await vaultPost(env, "/passkey/remove", { id: String(body.id || "") });
    return json({ ok: true });
  }

  return notFound();
}
