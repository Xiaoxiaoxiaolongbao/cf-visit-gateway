/**
 * 密钥与隐藏路径推导 —— 全站唯一碰密钥的地方。
 *
 * 设计原则：
 * 1. 密钥只存在于 Worker 的 env/secret 里，永不写入任何响应、页面、日志或构建产物。
 * 2. 客户端拿到的只有「按时间窗轮换的 HMAC 签名」，签名泄露也无法反推密钥，
 *    且最多 2 个时间窗（默认 20 分钟）后就失效。
 * 3. 接口路径由 HMAC(密钥, 固定盐) 派生，前缀不可猜测；未设置密钥时退化为固定盐，
 *    仅提供混淆而非保密（会打印一次 warn，方便在 wrangler tail 里看到）。
 */

const encoder = new TextEncoder();

/** 未配置 API_SECRET 时使用的默认盐。它写在开源代码里，因此只算混淆、不算保密。 */
export const DEFAULT_SECRET = "cf-visit-gateway:insecure-default-salt";

const PATH_SALT = "cf-visit-gateway:paths:v1";

/** 派生前缀长度（8 字节 → 16 个十六进制字符） */
const PREFIX_BYTES = 8;

/** 客户端签名长度（16 字节 → 32 个十六进制字符） */
const TOKEN_BYTES = 16;

/** 已导入的 HMAC key 按 secret 缓存，避免每请求重复 importKey */
const keyCache = new Map();
const pathCache = new Map();

const CACHE_LIMIT = 16;

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
      ["sign"],
    );
    cacheSet(keyCache, secret, key);
  }
  return key;
}

function toHex(buffer, bytes) {
  return [...new Uint8Array(buffer).slice(0, bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256 取前 N 字节的十六进制串 */
export async function hmacHex(secret, message, bytes) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return toHex(signature, bytes);
}

/**
 * 由密钥派生隐藏路由表。
 * @returns {Promise<{prefix:string, action:Record<string,string>, byPath:Map<string,string>}>}
 */
export function derivePaths(secret) {
  const cached = pathCache.get(secret);
  if (cached) return cached;

  const pending = hmacHex(secret, PATH_SALT, PREFIX_BYTES).then((prefix) => {
    const base = `/${prefix}`;
    const action = {
      v: `${base}/v`, // 记录访问
      s: `${base}/s`, // 读取统计
      c: `${base}/c`, // 记录跳转（AJAX 场景）
      g: `${base}/g`, // 302 跳转（可分享）
      r: `${base}/r`, // 令牌清零
      h: `${base}/h`, // 运维自检（需令牌）
      b: `${base}/b`, // 徽章（需显式开启）
    };
    return { prefix, action, byPath: new Map(Object.entries(action).map(([name, path]) => [path, name])) };
  });

  return cacheSet(pathCache, secret, pending);
}

export function bucketOf(now, windowSeconds) {
  return Math.floor(now / (windowSeconds * 1000));
}

/** 为当前时间窗签发客户端签名（不包含密钥本身） */
export function mintToken(secret, now, windowSeconds) {
  return hmacHex(secret, `client:${bucketOf(now, windowSeconds)}`, TOKEN_BYTES);
}

/** 校验客户端签名，容忍前一个时间窗的时钟偏差与页面缓存 */
export async function verifyToken(secret, token, now, windowSeconds) {
  if (typeof token !== "string" || token.length !== TOKEN_BYTES * 2) return false;
  const bucket = bucketOf(now, windowSeconds);
  const candidates = await Promise.all([
    hmacHex(secret, `client:${bucket}`, TOKEN_BYTES),
    hmacHex(secret, `client:${bucket - 1}`, TOKEN_BYTES),
  ]);
  return candidates.some((expected) => safeEqual(token, expected));
}

/** 定长逐字符比较，避免逐字节计时侧信道 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** URL 安全随机串，用于访客标识与 CSP nonce */
export function randomId(bytes = 16) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
