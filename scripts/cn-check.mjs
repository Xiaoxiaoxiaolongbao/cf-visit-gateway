/**
 * 中国大陆可达性体检：DNS 污染 / TCP / TLS / TTFB / HTTP3 一次量完。
 * 用法: npm run cn:check
 * 说明: 结果只代表"本机当前网络"，换手机热点再跑一次才有对比意义。
 */

import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { performance } from "node:perf_hooks";

const DOMAINS = ["xn--fiqx8ytpbr55a4embir4ug.com", "heyiwei.asia", "www.xn--fiqx8ytpbr55a4embir4ug.com"];
const RESOLVERS = [
  ["AliDNS", "https://dns.alidns.com/resolve"],
  ["DNSPod", "https://doh.pub/dns-query"],
];
const CONTROLS = ["cf-visit-gateway.228077668.workers.dev", "github.com", "raw.githubusercontent.com"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveDoH(base, name) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    return {
      ips: (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { ips: [], ms: -1, err: e.cause?.code || e.message };
  }
}

const tcpProbe = (ip, timeout = 6000) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const s = connect({ host: ip, port: 443 });
    let done = false;
    const fin = (ok, extra = "") => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ ok, ms: Math.round(performance.now() - t0), extra });
    };
    s.setTimeout(timeout, () => fin(false, "timeout"));
    s.on("connect", () => fin(true));
    s.on("error", (e) => fin(false, e.code || e.message));
  });

const tlsProbe = (ip, servername, timeout = 8000) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const s = tlsConnect({ host: ip, port: 443, servername, ALPNProtocols: ["h2", "http/1.1"] }, () => {
      const ms = Math.round(performance.now() - t0);
      const alpn = s.alpnProtocol;
      s.destroy();
      resolve({ ok: true, ms, alpn });
    });
    s.setTimeout(timeout, () => {
      s.destroy();
      resolve({ ok: false, ms: -1, extra: "timeout" });
    });
    s.on("error", (e) => resolve({ ok: false, ms: -1, extra: e.code || e.message }));
  });

console.log("== 1. DNS（两家国内 DoH 对比，判断是否被污染）==");
const ipSet = new Set();
for (const d of DOMAINS) {
  const rows = [];
  for (const [label, base] of RESOLVERS) {
    const r = await resolveDoH(base, d);
    rows.push([label, r]);
    for (const ip of r.ips) ipSet.add(ip);
  }
  const agree = new Set(rows.map(([, r]) => r.ips.slice().sort().join(",")).filter(Boolean)).size;
  console.log(`\n  ${d}`);
  for (const [label, r] of rows) {
    console.log(`    ${label.padEnd(8)} ${r.ips.join(", ") || "无记录"}  ${r.ms >= 0 ? r.ms + "ms" : r.err}`);
  }
  console.log(`    → ${agree <= 1 ? "一致（未污染）" : `不一致（疑似污染，${agree} 种答案）`}`);
  await sleep(120);
}

console.log("\n== 2. 边缘 IP 直连（TCP / TLS）==");
for (const ip of ipSet) {
  const tcp = await tcpProbe(ip);
  const tls = tcp.ok ? await tlsProbe(ip, DOMAINS[0]) : { ok: false, ms: -1, extra: "跳过" };
  console.log(
    `  ${ip.padEnd(16)} TCP ${tcp.ok ? tcp.ms + "ms" : "失败(" + tcp.extra + ")"}  TLS ${tls.ok ? tls.ms + "ms " + tls.alpn : "失败(" + tls.extra + ")"}`,
  );
  await sleep(120);
}

console.log("\n== 3. 页面实测（TTFB 是关键指标）==");
for (const d of DOMAINS) {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${d}/`, { signal: AbortSignal.timeout(15000) });
    const ttfb = Math.round(performance.now() - t0);
    console.log(
      `  ${d.padEnd(32)} HTTP ${res.status}  TTFB ${ttfb}ms  alt-svc=${res.headers.get("alt-svc") || "无"}`,
    );
  } catch (e) {
    console.log(`  ${d.padEnd(32)} 失败: ${e.cause?.code || e.message}`);
  }
}

console.log("\n== 4. 对照组（判断是全局墙还是本站问题）==");
for (const h of CONTROLS) {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${h}/`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    console.log(`  ${h.padEnd(44)} HTTP ${res.status}  ${Math.round(performance.now() - t0)}ms  可达`);
  } catch (e) {
    console.log(`  ${h.padEnd(44)} 不可达: ${e.cause?.code || e.message}`);
  }
}

console.log(`
判读方法
  1) DNS 两家不一致        → 域名被污染，换解析商或改域名
  2) TCP 全失败但 control 通 → 该边缘 IP 段被针对，换域名/IP
  3) TCP 通但 TLS 失败      → SNI 被阻断
  4) 全部通、只是 TTFB 大    → 不是墙，是路由绕路；换网络或换优选 IP 才有效
  5) workers.dev / raw.githubusercontent 单独失败 → 正常，这两个本来就被墙
`);
