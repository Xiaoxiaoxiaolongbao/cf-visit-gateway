/**
 * Durable Object 计数器 —— 精确统计后端（推荐）。
 *
 * 设计要点：
 * 1. 全局单实例（idFromName("global")），Cloudflare 天然把同一实例的请求串行化，
 *    因此 "读状态 → 改状态 → 写状态" 之间不存在竞态，计数严格准确。
 * 2. blockConcurrencyWhile 保证存储载入完成前不处理任何请求。
 * 3. 内存缓存 + 写穿（write-through）到 storage，避免每次请求反复反序列化。
 */

import { createStats, normalize, recordClick, recordVisit, viewStats } from "./stats.js";

const STORAGE_KEY = "stats";
const DEFAULT_TZ = 8;
const DEFAULT_SPAN = 7;

function intOr(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export class Counter {
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
      uidHash: url.searchParams.get("uidHash") || "",
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
}
