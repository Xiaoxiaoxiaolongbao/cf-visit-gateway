/**
 * 存储后端选择器。
 *
 * 三种模式，自动降级，Worker 代码无需分支：
 *   durable —— 绑定了 COUNTER（Durable Object），强一致精确计数，首选。
 *   kv      —— 只绑定了 VISITS（KV），读-改-写近似计数，适合无法配置 DO 的场景。
 *   none    —— 都没绑定，返回 configured:false，页面显示"统计未配置"而不是假数字。
 *
 * 统一接口：visit(params) / click(params) / stats(params)，返回同一个 view 结构。
 */

import { createStats, emptyView, normalize, recordClick, recordVisit, viewStats } from "./stats.js";

const KV_KEY = "stats";
const SINGLETON = "global";

export function createStore(env) {
  if (env?.COUNTER && typeof env.COUNTER.get === "function") return durableStore(env);
  if (env?.VISITS && typeof env.VISITS.get === "function") return kvStore(env);
  return noneStore();
}

function durableStore(env) {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(SINGLETON));

  const call = async (path, params) => {
    const url = new URL(`https://counter.internal${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
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
    reset: (p) => call("/reset", p),
  };
}

function kvStore(env) {
  const kv = env.VISITS;

  const load = async (now) => {
    let raw = null;
    try {
      raw = await kv.get(KV_KEY, "json");
    } catch {
      raw = null; // KV 尚无记录或读取失败时按空状态起步
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
    },
  };
}

function noneStore() {
  return {
    mode: "none",
    visit: async (p) => emptyView(p),
    click: async (p) => emptyView(p),
    stats: async (p) => emptyView(p),
    reset: async (p) => emptyView(p),
  };
}
