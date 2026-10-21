/**
 * Vault：留言（弹幕）、上传图片的元信息、passkey 凭据，三张表放在同一个 SQLite Durable Object 里。
 *
 * 为什么不把图片本身也放这里：DO 的单行有 2MB 上限，10MB 的图会被拒；
 * 图片字节存 KV（25MB/值），这里只存元信息。
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
];

const MAX_DANMAKU = 400;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export class Vault {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.ready = state.blockConcurrencyWhile(async () => {
      for (const ddl of DDL) this.sql.exec(ddl);
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
            return this.removeDanmaku(body);
          case "/upload":
            return this.addUpload(body);
          case "/uploads/remove":
            return this.removeUpload(body);
          case "/passkey":
            return this.addPasskey(body);
          case "/passkey/counter":
            this.sql.exec("UPDATE passkeys SET signcount = ? WHERE id = ?", Number(body.signCount) || 0, String(body.id));
            return json({ ok: true });
          case "/passkey/remove":
            this.sql.exec("DELETE FROM passkeys WHERE id = ?", String(body.id));
            return json({ ok: true });
          default:
            return json({ error: "unknown" }, 404);
        }
      }

      switch (path) {
        case "/danmaku":
          return this.listDanmaku(url);
        case "/uploads":
          return this.listUploads(url);
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
    const text = String(body.text || "").trim().slice(0, 60);
    const color = /^#[0-9a-f]{6}$/i.test(String(body.color || "")) ? String(body.color).toLowerCase() : "#f5f5f7";
    const size = Math.min(28, Math.max(12, Number(body.size) || 15));
    const iphash = String(body.iphash || "").slice(0, 64);
    const now = Date.now();

    if (!text) return json({ error: "内容为空" }, 400);

    // 同一来源 60 秒内最多 3 条
    const recent = this.sql
      .exec("SELECT COUNT(*) AS n FROM danmaku WHERE iphash = ? AND created > ?", iphash, now - 60000)
      .one().n;
    if (recent >= 3) return json({ error: "发送太快，稍等一下" }, 429);

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    this.sql.exec(
      "INSERT INTO danmaku (id, text, color, size, created, iphash, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id,
      text,
      color,
      size,
      now,
      iphash,
    );

    // 只保留最近的 MAX_DANMAKU 条
    this.sql.exec(
      "DELETE FROM danmaku WHERE id IN (SELECT id FROM danmaku ORDER BY created DESC LIMIT -1 OFFSET ?)",
      MAX_DANMAKU,
    );
    return json({ ok: true, item: { id, text, color, size, created: now } });
  }

  listDanmaku(url) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    const all = url.searchParams.get("all") === "1";
    const where = all ? "" : "WHERE hidden = 0";
    const items = this.sql
      .exec(`SELECT id, text, color, size, created FROM danmaku ${where} ORDER BY created DESC LIMIT ?`, limit)
      .toArray();
    return json({ items: items.reverse() });
  }

  removeDanmaku(body) {
    this.sql.exec("DELETE FROM danmaku WHERE id = ?", String(body.id || ""));
    return json({ ok: true });
  }

  /* ------------------------------------------------------------ 图片 */

  addUpload(body) {
    const id = String(body.id || "");
    if (!/^[a-z0-9]{16,32}$/.test(id)) return json({ error: "id 非法" }, 400);
    const iphash = String(body.iphash || "").slice(0, 64);
    const now = Date.now();

    const recent = this.sql
      .exec("SELECT COUNT(*) AS n FROM uploads WHERE iphash = ? AND created > ?", iphash, now - 3600000)
      .one().n;
    if (recent >= 8) return json({ error: "上传太频繁，一小时后再试" }, 429);

    this.sql.exec(
      "INSERT INTO uploads (id, mime, bytes, created, iphash, title, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id,
      String(body.mime || "image/jpeg"),
      Number(body.bytes) || 0,
      now,
      iphash,
      String(body.title || "").slice(0, 60),
    );
    return json({ ok: true, item: { id, mime: body.mime, bytes: Number(body.bytes) || 0, created: now } });
  }

  listUploads(url) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    const all = url.searchParams.get("all") === "1";
    const where = all ? "" : "WHERE hidden = 0";
    const items = this.sql
      .exec(`SELECT id, mime, bytes, created, title FROM uploads ${where} ORDER BY created DESC LIMIT ?`, limit)
      .toArray();
    return json({ items });
  }

  removeUpload(body) {
    this.sql.exec("DELETE FROM uploads WHERE id = ?", String(body.id || ""));
    return json({ ok: true });
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
      String(body.name || "这台电脑").slice(0, 40),
    );
    return json({ ok: true, id });
  }
}
