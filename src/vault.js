/**
 * Vault：留言（弹幕）、上传图片元信息（含 IP 与双指纹）、passkey 凭据、IP 黑名单。
 *
 * 约定：
 *   - ip 明文只存在这里，只有 admin 接口会回传；公开接口 /api/wall 永不包含
 *   - 双指纹：bfp = 浏览器指纹（canvas/webgl/ua/语言/时区），dfp = 设备指纹（屏幕/核数/内存/平台）
 *     按「仅记录对比」的要求，指纹不参与拦截，只落库
 *   - 黑名单按 IP 只拦上传图片（danmaku 不受影响），表 blocks
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS danmaku (
     id TEXT PRIMARY KEY, text TEXT NOT NULL, color TEXT NOT NULL, size INTEGER NOT NULL,
     created INTEGER NOT NULL, iphash TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS danmaku_created ON danmaku (created DESC)`,
  `CREATE TABLE IF NOT EXISTS uploads (
     id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL,
     iphash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS uploads_created ON uploads (created DESC)`,
  `CREATE TABLE IF NOT EXISTS passkeys (
     id TEXT PRIMARY KEY, jwk TEXT NOT NULL, alg INTEGER NOT NULL,
     signcount INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, name TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     contact TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created INTEGER NOT NULL,
     ip TEXT NOT NULL DEFAULT '', bfp TEXT NOT NULL DEFAULT '', dfp TEXT NOT NULL DEFAULT '',
     reply TEXT NOT NULL DEFAULT '', replied INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS messages_created ON messages (created DESC)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS blocks (
     ip TEXT PRIMARY KEY, created INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT ''
   )`,
];

/** 老库补列：SQLite 不支持 ADD COLUMN IF NOT EXISTS，只能逐句试 */
const MIGRATIONS = [
  "ALTER TABLE uploads ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE uploads ADD COLUMN bfp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE uploads ADD COLUMN dfp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE danmaku ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE danmaku ADD COLUMN bfp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE danmaku ADD COLUMN dfp TEXT NOT NULL DEFAULT ''",
];

const MAX_DANMAKU = 400;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (value, max) => String(value == null ? "" : value).slice(0, max);

/**
 * IP 归一化：IPv4 映射的 IPv6（::ffff:1.2.3.4）会被当成另一个值绕过黑名单，
 * 这里统一去掉前缀并小写。
 */
export function normIp(raw) {
  let ip = clean(raw, 64).trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return clean(ip, 45);
}

export class Vault {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.ready = state.blockConcurrencyWhile(async () => {
      for (const ddl of DDL) this.sql.exec(ddl);
      for (const sql of MIGRATIONS) {
        try {
          this.sql.exec(sql);
        } catch {
          /* 列已存在，忽略 */
        }
      }
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        switch (path) {
          case "/danmaku":
            return this.addDanmaku(body);
          case "/danmaku/remove":
            this.sql.exec("DELETE FROM danmaku WHERE id = ?", String(body.id || ""));
            return json({ ok: true });
          case "/upload":
            return this.addUpload(body);
          case "/uploads/remove":
            this.sql.exec("DELETE FROM uploads WHERE id = ?", String(body.id || ""));
            return json({ ok: true });
          case "/message":
            return this.addMessage(body);
          case "/messages/reply":
            return this.replyMessage(body);
          case "/messages/remove":
            this.sql.exec("DELETE FROM messages WHERE id = ?", String(body.id || ""));
            return json({ ok: true });
          case "/meta":
            this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", String(body.k || ""), String(body.v || ""));
            return json({ ok: true });
          case "/block":
            return this.addBlock(body);
          case "/unblock":
            this.sql.exec("DELETE FROM blocks WHERE ip = ?", String(body.ip || ""));
            return json({ ok: true });
          case "/passkey":
            return this.addPasskey(body);
          case "/passkey/counter":
            this.sql.exec("UPDATE passkeys SET signcount = ? WHERE id = ?", Number(body.signCount) || 0, String(body.id));
            return json({ ok: true });
          case "/passkey/remove":
            this.sql.exec("DELETE FROM passkeys WHERE id = ?", String(body.id || ""));
            return json({ ok: true });
          default:
            return json({ error: "unknown" }, 404);
        }
      }

      switch (path) {
        case "/danmaku": {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
          const all = url.searchParams.get("all") === "1";
          const where = all ? "" : "WHERE hidden = 0";
          const cols = all ? "id, text, color, size, created, ip, bfp, dfp" : "id, text, color, size, created";
          const items = this.sql
            .exec(`SELECT ${cols} FROM danmaku ${where} ORDER BY created DESC LIMIT ?`, limit)
            .toArray();
          return json({ items: items.reverse() });
        }
        case "/uploads": {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
          const all = url.searchParams.get("all") === "1";
          const where = all ? "" : "WHERE hidden = 0";
          const cols = all
            ? "id, mime, bytes, created, title, ip, bfp, dfp"
            : "id, mime, bytes, created, title";
          const items = this.sql
            .exec(`SELECT ${cols} FROM uploads ${where} ORDER BY created DESC LIMIT ?`, limit)
            .toArray();
          return json({ items });
        }
        case "/messages": {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
          return json({
            items: this.sql
              .exec(
                "SELECT id, code, name, contact, body, created, ip, bfp, dfp, reply, replied FROM messages ORDER BY created DESC LIMIT ?",
                limit,
              )
              .toArray(),
          });
        }
        case "/message": {
          const code = String(url.searchParams.get("code") || "");
          const rows = this.sql
            .exec("SELECT body, reply, replied, created FROM messages WHERE code = ?", code)
            .toArray();
          return json({ item: rows[0] || null });
        }
        case "/meta": {
          const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", url.searchParams.get("k") || "").toArray();
          return json({ v: rows[0] ? rows[0].v : null });
        }
        case "/blocks":
          return json({ items: this.sql.exec("SELECT ip, created, reason FROM blocks ORDER BY created DESC").toArray() });
        case "/passkeys":
          return json({ items: this.sql.exec("SELECT id, name, created FROM passkeys ORDER BY created ASC").toArray() });
        case "/passkey": {
          const rows = this.sql.exec("SELECT * FROM passkeys WHERE id = ?", url.searchParams.get("id") || "").toArray();
          return json({ item: rows[0] || null });
        }
        case "/stats":
          return json({
            danmaku: this.sql.exec("SELECT COUNT(*) AS n FROM danmaku").one().n,
            uploads: this.sql.exec("SELECT COUNT(*) AS n FROM uploads").one().n,
            passkeys: this.sql.exec("SELECT COUNT(*) AS n FROM passkeys").one().n,
            blocks: this.sql.exec("SELECT COUNT(*) AS n FROM blocks").one().n,
          });
        default:
          return json({ error: "unknown" }, 404);
      }
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }

  /* ------------------------------------------------------------ 弹幕 */

  addDanmaku(body) {
    const text = clean(body.text, 60).trim();
    const color = /^#[0-9a-f]{6}$/i.test(String(body.color || "")) ? String(body.color).toLowerCase() : "#f5f5f7";
    const size = Math.min(28, Math.max(12, Number(body.size) || 15));
    const iphash = clean(body.iphash, 64);
    const ip = normIp(body.ip);
    const now = Date.now();

    if (!text) return json({ error: "内容为空" }, 400);

    // 黑名单同样拦弹幕（按最新要求：图片与弹幕都受限）
    if (ip && this.sql.exec("SELECT 1 AS hit FROM blocks WHERE ip = ?", ip).toArray().length) {
      return json({ error: "该网络已被限制发送，如有疑问可联系管理员", blocked: true }, 403);
    }

    const recent = this.sql
      .exec("SELECT COUNT(*) AS n FROM danmaku WHERE iphash = ? AND created > ?", iphash, now - 60000)
      .one().n;
    if (recent >= 3) return json({ error: "发送太快，稍等一下" }, 429);

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    this.sql.exec(
      `INSERT INTO danmaku (id, text, color, size, created, iphash, hidden, ip, bfp, dfp)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      text,
      color,
      size,
      now,
      iphash,
      ip,
      clean(body.bfp, 32),
      clean(body.dfp, 32),
    );

    this.sql.exec(
      "DELETE FROM danmaku WHERE id IN (SELECT id FROM danmaku ORDER BY created DESC LIMIT -1 OFFSET ?)",
      MAX_DANMAKU,
    );
    return json({ ok: true, item: { id, text, color, size, created: now } });
  }

  /* ------------------------------------------------------------ 图片 */

  addUpload(body) {
    const id = String(body.id || "");
    if (!/^[a-z0-9]{16,32}$/.test(id)) return json({ error: "id 非法" }, 400);

    const ip = normIp(body.ip);
    if (ip && this.sql.exec("SELECT 1 AS hit FROM blocks WHERE ip = ?", ip).toArray().length) {
      return json({ error: "该 IP 已被限制上传", blocked: true }, 403);
    }

    const iphash = clean(body.iphash, 64);
    const now = Date.now();
    const recent = this.sql
      .exec("SELECT COUNT(*) AS n FROM uploads WHERE iphash = ? AND created > ?", iphash, now - 3600000)
      .one().n;
    if (recent >= 8) return json({ error: "上传太频繁，一小时后再试" }, 429);

    this.sql.exec(
      `INSERT INTO uploads (id, mime, bytes, created, iphash, title, hidden, ip, bfp, dfp)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      clean(body.mime, 40) || "image/jpeg",
      Number(body.bytes) || 0,
      now,
      iphash,
      clean(body.title, 60),
      ip,
      clean(body.bfp, 32),
      clean(body.dfp, 32),
    );
    return json({ ok: true, item: { id, mime: body.mime, bytes: Number(body.bytes) || 0, created: now } });
  }

  /* ---------------------------------------------------------- 黑名单 */

  addBlock(body) {
    const ip = normIp(body.ip);
    if (!ip) return json({ error: "缺少 IP" }, 400);
    this.sql.exec(
      "INSERT OR REPLACE INTO blocks (ip, created, reason) VALUES (?, ?, ?)",
      ip,
      Date.now(),
      clean(body.reason, 80),
    );
    return json({ ok: true, ip });
  }

  /* ---------------------------------------------------------- passkey */

  addPasskey(body) {
    const id = String(body.id || "");
    if (!id || !body.jwk) return json({ error: "参数不全" }, 400);
    this.sql.exec(
      "INSERT OR REPLACE INTO passkeys (id, jwk, alg, signcount, created, name) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      JSON.stringify(body.jwk),
      Number(body.alg) || -7,
      Number(body.signCount) || 0,
      Date.now(),
      clean(body.name, 40) || "这台电脑",
    );
    return json({ ok: true, id });
  }
}

/* -------------------------------- 站长私信 */

const MAX_MESSAGE = 500;

Object.assign(Vault.prototype, {
  addMessage(body) {
    const text = clean(body.body, MAX_MESSAGE).trim();
    if (!text) return json({ error: "内容为空" }, 400);

    const ip = normIp(body.ip);
    if (ip && this.sql.exec("SELECT 1 AS hit FROM blocks WHERE ip = ?", ip).toArray().length) {
      return json({ error: "该网络已被限制提交", blocked: true }, 403);
    }

    const now = Date.now();
    if (ip) {
      const recent = this.sql
        .exec("SELECT COUNT(*) AS n FROM messages WHERE ip = ? AND created > ?", ip, now - 3600000)
        .one().n;
      if (recent >= 5) return json({ error: "提交太频繁，一小时后再试" }, 429);
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const code = [...crypto.getRandomValues(new Uint8Array(5))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.sql.exec(
      `INSERT INTO messages (id, code, name, contact, body, created, ip, bfp, dfp, reply, replied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
      id,
      code,
      clean(body.name, 20),
      clean(body.contact, 60),
      text,
      now,
      ip,
      clean(body.bfp, 32),
      clean(body.dfp, 32),
    );
    return json({ ok: true, id, code });
  },

  replyMessage(body) {
    const id = String(body.id || "");
    const reply = clean(body.reply, MAX_MESSAGE).trim();
    if (!id) return json({ error: "缺少 id" }, 400);
    this.sql.exec(
      "UPDATE messages SET reply = ?, replied = ? WHERE id = ?",
      reply,
      reply ? 1 : 0,
      id,
    );
    return json({ ok: true });
  },
});
