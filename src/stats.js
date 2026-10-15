/**
 * 计数状态机 —— 纯函数，无 IO、无环境依赖。
 *
 * 状态形状（同时兼容 Durable Object Storage 与 KV）：
 * {
 *   v:      1,                          // 结构版本号
 *   first:  1710000000000,              // 首次记录时间
 *   last:   1710003600000,              // 最近一次活动时间
 *   total:  1024,                       // 累计访问量 (PV)
 *   uv:     321,                        // 累计独立访客（去重窗口见 UV_WINDOW_MS）
 *   clicks: 87,                         // 跳转次数
 *   days:   { "2026-10-15": 42, ... },  // 每日 PV，仅保留最近 MAX_DAYS 天
 *   seen:   { "<uidHash>": 时间戳 }      // 去重窗口内的访客指纹
 * }
 */

export const STATS_VERSION = 1;

/** 每日明细保留天数（对应页面上"近 7 天"图表的历史冗余） */
export const MAX_DAYS = 14;

/** 独立访客去重窗口：同一访客 12 小时内只计一次 UV */
export const UV_WINDOW_MS = 12 * 60 * 60 * 1000;

/** seen 表上限，超过后按时间淘汰最旧记录，避免状态无限膨胀 */
export const MAX_SEEN = 20000;

const DAY_MS = 86400000;

/** 把时间戳折算到指定时区偏移下的日期键 YYYY-MM-DD */
export function dayKey(ts, tzOffsetHours = 8) {
  const shifted = ts + tzOffsetHours * 3600000;
  return new Date(shifted).toISOString().slice(0, 10);
}

export function createStats(now = Date.now()) {
  return {
    v: STATS_VERSION,
    first: now,
    last: now,
    total: 0,
    uv: 0,
    clicks: 0,
    days: {},
    seen: {},
  };
}

/** 把任意来源（旧版本、被截断、被污染）的数据规整成合法状态 */
export function normalize(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return createStats(now);

  const days = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [k, v] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))) {
        days[k] = Math.max(0, Math.trunc(Number(v)));
      }
    }
  }

  const seen = {};
  if (raw.seen && typeof raw.seen === "object") {
    for (const [k, v] of Object.entries(raw.seen)) {
      if (typeof k === "string" && k.length <= 64 && Number.isFinite(Number(v))) {
        seen[k] = Number(v);
      }
    }
  }

  const nowSafe = Number.isFinite(now) ? now : Date.now();
  return {
    v: STATS_VERSION,
    first: Number.isFinite(Number(raw.first)) ? Number(raw.first) : nowSafe,
    last: Number.isFinite(Number(raw.last)) ? Number(raw.last) : nowSafe,
    total: Math.max(0, Math.trunc(Number(raw.total) || 0)),
    uv: Math.max(0, Math.trunc(Number(raw.uv) || 0)),
    clicks: Math.max(0, Math.trunc(Number(raw.clicks) || 0)),
    days,
    seen,
  };
}

/** 清理去重窗口外的访客指纹 */
function pruneSeen(stats, now) {
  const cutoff = now - UV_WINDOW_MS;
  for (const [k, ts] of Object.entries(stats.seen)) {
    if (!(ts > cutoff)) delete stats.seen[k];
  }

  const seenKeys = Object.keys(stats.seen);
  if (seenKeys.length > MAX_SEEN) {
    seenKeys
      .sort((a, b) => stats.seen[a] - stats.seen[b])
      .slice(0, seenKeys.length - MAX_SEEN)
      .forEach((k) => delete stats.seen[k]);
  }
}

/** 每日明细只保留最近 MAX_DAYS 天 */
function trimDays(stats) {
  const keys = Object.keys(stats.days).sort();
  if (keys.length > MAX_DAYS) {
    for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete stats.days[k];
  }
}

/**
 * 记录一次页面访问（会就地修改 stats）。
 * @returns {{ isNewVisitor: boolean }}
 */
export function recordVisit(stats, { uidHash, now, tz = 8 }) {
  // 先淘汰过期指纹，再判断是否新访客：
  // 否则"去重窗口外返回的老访客"会因为旧条目还没被清理而被误判为已访问过。
  pruneSeen(stats, now);

  const day = dayKey(now, tz);
  stats.total += 1;
  stats.days[day] = (stats.days[day] || 0) + 1;
  stats.last = now;
  if (Number.isFinite(stats.first) && stats.first > now) stats.first = now;

  const isNewVisitor = Boolean(uidHash) && !stats.seen[uidHash];
  if (isNewVisitor) stats.uv += 1;
  if (uidHash) stats.seen[uidHash] = now;

  trimDays(stats);
  return { isNewVisitor };
}

/** 记录一次跳转（会就地修改 stats） */
export function recordClick(stats, { now }) {
  stats.clicks += 1;
  stats.last = now;
  return {};
}

/**
 * 生成对外可见的统计视图（不含 seen 指纹表等隐私数据）。
 * @returns {{configured:boolean,total:number,uv:number,clicks:number,today:number,
 *            todayKey:string,first:number|null,last:number|null,
 *            series:Array<{d:string,pv:number}>}}
 */
export function viewStats(stats, { now, tz = 8, span = 7 }) {
  const todayKey = dayKey(now, tz);
  const series = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = dayKey(now - i * DAY_MS, tz);
    series.push({ d, pv: stats.days[d] || 0 });
  }
  return {
    configured: true,
    total: stats.total,
    uv: stats.uv,
    clicks: stats.clicks,
    today: stats.days[todayKey] || 0,
    todayKey,
    first: Number.isFinite(stats.first) ? stats.first : null,
    last: Number.isFinite(stats.last) ? stats.last : null,
    series,
  };
}

/** 未绑定任何存储后端时对外暴露的空视图，页面据此显示"未配置"而不是假数据 */
export function emptyView({ now = Date.now(), tz = 8, span = 7 } = {}) {
  return { ...viewStats(createStats(now), { now, tz, span }), configured: false };
}
