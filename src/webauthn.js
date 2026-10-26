/**
 * 最小可用的 WebAuthn（passkey）服务端校验。
 *
 * 只实现 authenticator 会真正用到的东西：
 *   - 注册：attestation=none，解析 authData 取出 credentialId 与 COSE 公钥
 *   - 登录：校验 clientDataJSON / rpIdHash / UP 标志 / 签名，并回写 signCount
 *
 * 两个容易踩的坑（这里都处理了）：
 *   1. WebCrypto 的 ECDSA.verify 要的是 raw r||s，而 WebAuthn 给的是 DER 序列
 *   2. COSE 的公钥坐标是 byte string，要转成 base64url 才能交给 importKey
 */

const TE = new TextEncoder();
const TD = new TextDecoder();

export function b64uEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=/".repeat((4 - (s.length % 4)) % 4).replace("/", "");
  const bin = atob(s + (s.length % 4 ? "=".repeat(4 - (s.length % 4)) : ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ CBOR */

function decodeItem(b, i) {
  const ib = b[i];
  const major = ib >> 5;
  const ai = ib & 0x1f;
  i += 1;
  let len = ai;

  if (ai === 24) {
    len = b[i];
    i += 1;
  } else if (ai === 25) {
    len = (b[i] << 8) | b[i + 1];
    i += 2;
  } else if (ai === 26) {
    len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    i += 4;
  } else if (ai === 27) {
    // 64 位整数：WebAuthn 里只出现在 signCount 之类的字段，这里不需要精确值
    i += 8;
    len = 0;
  }

  switch (major) {
    case 0:
      return [len, i];
    case 1:
      return [-1 - len, i];
    case 2:
      return [b.subarray(i, i + len), i + len];
    case 3:
      return [TD.decode(b.subarray(i, i + len)), i + len];
    case 4: {
      const arr = [];
      for (let k = 0; k < len; k += 1) {
        const [v, ni] = decodeItem(b, i);
        arr.push(v);
        i = ni;
      }
      return [arr, i];
    }
    case 5: {
      const map = {};
      for (let k = 0; k < len; k += 1) {
        const [key, ni] = decodeItem(b, i);
        const [val, ni2] = decodeItem(b, ni);
        map[String(key)] = val;
        i = ni2;
      }
      return [map, i];
    }
    case 6: {
      const [, ni] = decodeItem(b, i);
      return decodeItem(b, ni);
    }
    default:
      if (ai === 20) return [false, i];
      if (ai === 21) return [true, i];
      if (ai === 22) return [null, i];
      return [null, i];
  }
}

export function cborDecode(bytes) {
  return decodeItem(bytes, 0)[0];
}

/* ------------------------------------------------------------ authData */

export function parseAuthData(b) {
  if (b.length < 37) throw new Error("authData 太短");
  const rpIdHash = b.subarray(0, 32);
  const flags = b[32];
  const signCount = ((b[33] << 24) | (b[34] << 16) | (b[35] << 8) | b[36]) >>> 0;
  let i = 37;
  let credentialId = null;
  let cose = null;

  if (flags & 0x40) {
    i += 16; // aaguid
    const idLen = (b[i] << 8) | b[i + 1];
    i += 2;
    credentialId = b.subarray(i, i + idLen);
    i += idLen;
    cose = decodeItem(b, i)[0];
  }
  return { rpIdHash, flags, signCount, credentialId, cose };
}

/* ---------------------------------------------------------------- COSE */

export function coseToKey(cose) {
  const kty = cose["1"];
  const alg = cose["3"];
  if (kty === 2 && alg === -7) {
    const x = cose["-2"];
    const y = cose["-3"];
    if (!x || !y) throw new Error("EC 公钥缺少坐标");
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose["-1"];
    const e = cose["-2"];
    if (!n || !e) throw new Error("RSA 公钥缺少参数");
    return { alg: -257, jwk: { kty: "RSA", n: b64uEncode(n), e: b64uEncode(e) } };
  }
  throw new Error(`不支持的密钥类型 kty=${kty} alg=${alg}`);
}

const IMPORT_ALG = {
  EC: { name: "ECDSA", namedCurve: "P-256" },
  RSA: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
};

/** DER(SEQUENCE of 2 INTEGER) -> raw r||s（ECDSA 校验必须用 raw） */
export function derToRaw(sig) {
  let i = 0;
  if (sig[i] !== 0x30) throw new Error("签名不是 DER 序列");
  i += 1;
  let seqLen = sig[i];
  i += 1;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k += 1) seqLen = (seqLen << 8) | sig[i + k];
    i += n;
  }

  const readInt = () => {
    if (sig[i] !== 0x02) throw new Error("DER 段不是 INTEGER");
    i += 1;
    let len = sig[i];
    i += 1;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k += 1) len = (len << 8) | sig[i + k];
      i += n;
    }
    let v = sig.subarray(i, i + len);
    i += len;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    return v;
  };

  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(64);
  out.set(r.subarray(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  out.set(s.subarray(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return out;
}

/* ------------------------------------------------------------ 校验入口 */

function checkClientData(json, expectedType, challenge, origin) {
  let data;
  try {
    data = JSON.parse(TD.decode(b64uDecode(json)));
  } catch {
    throw new Error("clientDataJSON 解析失败");
  }
  if (data.type !== expectedType) throw new Error(`操作类型不符：${data.type}`);
  if (data.challenge !== challenge) throw new Error("challenge 不匹配");
  if (!origin || data.origin !== origin) throw new Error(`origin 不匹配：${data.origin}`);
  return data;
}

export async function verifyRegistration({ payload, challenge, origin, rpId, requireUV = true }) {
  checkClientData(payload.clientDataJSON, "webauthn.create", challenge, origin);

  const att = cborDecode(b64uDecode(payload.attestationObject));
  if (!att || !att.authData) throw new Error("attestationObject 结构异常");

  const auth = parseAuthData(new Uint8Array(att.authData));
  const expectRp = await sha256(TE.encode(rpId));
  if (!bytesEq(auth.rpIdHash, expectRp)) throw new Error("rpIdHash 不匹配");
  if (!(auth.flags & 0x01)) throw new Error("用户未完成存在性验证");
  // 我们请求的是 userVerification=required，就必须校验 UV 标志，否则模拟器可跳过
  if (requireUV && !(auth.flags & 0x04)) throw new Error("未完成用户验证（UV 标志缺失）");
  if (!auth.credentialId || !auth.cose) throw new Error("缺少凭据或公钥");

  const { alg, jwk } = coseToKey(auth.cose);
  return { credentialId: b64uEncode(auth.credentialId), alg, jwk, signCount: auth.signCount };
}

export async function verifyAssertion({ payload, challenge, origin, rpId, jwk, alg, storedCount = 0, requireUV = true }) {
  checkClientData(payload.clientDataJSON, "webauthn.get", challenge, origin);

  const authData = b64uDecode(payload.authenticatorData);
  const auth = parseAuthData(authData);
  const expectRp = await sha256(TE.encode(rpId));
  if (!bytesEq(auth.rpIdHash, expectRp)) throw new Error("rpIdHash 不匹配");
  if (!(auth.flags & 0x01)) throw new Error("用户未完成存在性验证");
  if (requireUV && !(auth.flags & 0x04)) throw new Error("未完成用户验证（UV 标志缺失）");
  // 计数器必须递增：为 0 的认证器不做约束，其余情况出现「不增」视为克隆凭据
  if (storedCount > 0 && auth.signCount > 0 && auth.signCount <= storedCount) {
    throw new Error("认证器计数器未递增，疑似克隆凭据");
  }

  const key = await crypto.subtle.importKey("jwk", jwk, IMPORT_ALG[jwk.kty], false, ["verify"]);
  const clientHash = await sha256(b64uDecode(payload.clientDataJSON));
  const signed = concat(authData, clientHash);
  const signature = b64uDecode(payload.signature);

  let ok;
  if (jwk.kty === "EC") {
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature), signed);
  } else {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  }
  if (!ok) throw new Error("签名校验失败");

  return { signCount: auth.signCount };
}
