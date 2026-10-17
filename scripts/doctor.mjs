/**
 * 部署体检 —— `npm run doctor` / `npm run doctor:ca`
 *
 * 从外部（DNS + HTTP）体检线上站点，并把「打不开」具体归因到某一层，给出对应修法。
 * 不依赖任何密钥即可跑；若本机能读到 API_SECRET / ADMIN_TOKEN（环境变量或 .dev.vars），
 * 会顺带把隐藏路径、计数器、后端模式也验一遍。
 *
 * 用法：
 *   npm run doctor                      # 自动读 wrangler.toml 里配置的域名
 *   npm run doctor -- heyiwei.asia www.heyiwei.asia
 *   BASE=https://heyiwei.asia npm run doctor
 *   npm run doctor:ca                   # 本机有 TLS 检查代理（Node 不认其根证书）时用这个
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as dns } from "node:dns";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 15000;

/* ------------------------------------------------------------ 小工具 */

const ok = (s) => `\u2713 ${s}`;
const bad = (s) => `\u2717 ${s}`;
const warn = (s) => `! ${s}`;

function readIfExists(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 从 wrangler.toml 的 [[routes]] 里取 pattern，以及 [vars] 里的 TARGET_URL */
function readConfig() {
  const toml = readIfExists(resolve(ROOT, "wrangler.toml"));
  const patterns = [...toml.matchAll(/^\s*pattern\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  const target = /^\s*TARGET_URL\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || "";
  return { patterns, target };
}

/** 从 .dev.vars 读本地密钥（该文件已被 gitignore） */
function readDevVars() {
  const out = {};
  for (const line of readIfExists(resolve(ROOT, ".dev.vars")).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const CLOUDFLARE_PREFIXES = [
  /^104\.(1[6-9]|2\d|3[01])\./, /^172\.(6[4-9]|7[01])\./, /^162\.15[89]\./,
  /^173\.245\./, /^188\.114\./, /^190\.93\./, /^197\.234\.2[4-7]\./,
  /^198\.41\./, /^141\.101\./, /^108\.162\./, /^103\.(21|22|31)\./, /^131\.0\.7[2-5]\./,
];

function looksCloudflare(ip) {
  if (ip.includes(":")) return true; // IPv6 段太碎，不做判断
  return CLOUDFLARE_PREFIXES.some((re) => re.test(ip));
}

async function resolveHost(host) {
  const result = { a: [], aaaa: [], cname: [], ns: [], error: "" };
  try {
    result.a = await dns.resolve4(host);
  } catch (e) {
    result.error = result.error || e.code || e.message;
  }
  try {
    result.aaaa = await dns.resolve6(host);
  } catch {}
  try {
    result.cname = await dns.resolveCname(host);
  } catch {}
  try {
    const zone = host.split(".").slice(-2).join(".");
    result.ns = await dns.resolveNs(zone);
  } catch {}
  return result;
}

/** DoH 兜底：本机 DNS 被劫持时用 HTTPS 直接问解析器 */
async function resolveViaDoh(host) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json();
    return { status: body.Status, answers: (body.Answer || []).map((a) => a.data) };
  } catch (err) {
    const code = err.cause?.code || err.cause?.message || err.message || "";
    return { status: -1, answers: [], error: code };
  }
}

async function httpGet(url, options = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: options.redirect || "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "cf-visit-gateway-doctor" },
    });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.cause?.message || err.message, ms: Date.now() - started };
  }
}

/* ------------------------------------------------------------ 体检主体 */

const cliHosts = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const cfg = readConfig();
let hosts = cliHosts;
if (!hosts.length) {
  const fromBase = process.env.BASE ? [new URL(process.env.BASE).host] : [];
  hosts = fromBase.length ? fromBase : [...new Set(cfg.patterns)];
}
if (!hosts.length) {
  console.log("未指定域名，也没有在 wrangler.toml 里找到 [[routes]] pattern。");
  console.log("用法: npm run doctor -- 你的域名.com");
  process.exit(2);
}

const devVars = readDevVars();
const apiSecret = process.env.API_SECRET || devVars.API_SECRET || "";
const adminToken = process.env.ADMIN_TOKEN || devVars.ADMIN_TOKEN || "";
const { derivePaths, mintToken } = await import(pathToFileURL(resolve(ROOT, "src/secret.js")).href);

let hardFailure = false;
const notes = [];

for (const host of hosts) {
  console.log(`\n================ ${host} ================`);

  const dnsResult = await resolveHost(host);
  const apexish = host.split(".").length === 2;
  const onCloudflareNs = dnsResult.ns.some((ns) => ns.endsWith(".ns.cloudflare.com"));
  console.log(`DNS  A/AAAA : ${[...dnsResult.a, ...dnsResult.aaaa].join(", ") || "（无记录）"}`);
  if (dnsResult.cname.length) console.log(`     CNAME  : ${dnsResult.cname.join(", ")}`);
  if (dnsResult.ns.length) console.log(`     权威 NS : ${dnsResult.ns.join(", ")}  ${onCloudflareNs ? ok("已托管在 Cloudflare") : warn("不是 Cloudflare 的 NS")}`);
  if (dnsResult.error) console.log(`     解析状态: ${dnsResult.error}`);

  if (!dnsResult.a.length && !dnsResult.aaaa.length) {
    const doh = await resolveViaDoh(host);
    if (doh.answers.length) {
      console.log(`     DoH 兜底: ${doh.answers.join(", ")}   ${warn("本机 DNS 结果与公共解析器不一致，可能是本机 DNS 被劫持")}`);
    } else if (doh.status === 3) {
      console.log(`     DoH 兜底: NXDOMAIN（域名在公网解析中不存在）`);
    } else if (doh.status === 0) {
      console.log(`     DoH 兜底: NOERROR 但没有任何 A 记录`);
    } else if (doh.error) {
      console.log(`     DoH 兜底: 不可用（${doh.error}）`);
      if (/CERT|VERIFY|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(String(doh.error))) {
        notes.push("DoH 查询因本机 TLS 检查代理失败：请改用 `npm run doctor:ca`");
      }
    }

    hardFailure = true;
    console.log(`  ${bad("域名没有指向任何 IP —— 浏览器在这一步就失败，就是「打不开」的直接原因")}`);
    if (onCloudflareNs) {
      console.log("     已确认：该域名的权威 NS 就是 Cloudflare，所以问题是「这个主机名没有绑定到 Worker」，不是域名没接入。");
    }
    console.log("     修法（任选其一）：");
    console.log("       a) 让 Worker 自己接管域名：在 wrangler.toml 加");
    console.log(`            [[routes]]`);
    console.log(`            pattern = "${host}"`);
    console.log(`            custom_domain = true`);
    console.log("          然后 `npm run deploy`（会自动创建代理 A/AAAA 记录与证书）");
    console.log("       b) 面板操作：Worker → Settings → Domains & Routes → Add custom domain");
    console.log("     注意：如果该主机名上已存在 A/AAAA/CNAME 记录，custom domain 会创建失败，需先删掉冲突记录。");
    if (apexish) console.log("     另注意 www 与裸域是两个不同的主机名，要分别绑定。");
    continue;
  }

  const cfLike = [...dnsResult.a].every(looksCloudflare);
  console.log(`     边缘判断: ${cfLike ? ok("解析到 Cloudflare 边缘地址段") : bad("解析到的 IP 不像 Cloudflare 边缘，可能未走 CF 代理或被劫持")}`);

  const base = `https://${host}`;
  const page = await httpGet(`${base}/`);
  if (page.status === 0) {
    hardFailure = true;
    console.log(`  ${bad(`HTTPS 请求失败：${page.error}（${page.ms}ms）`)}`);
    console.log("     含义：DNS 通了但连不上。常见原因：本机/所在网络拦截 443、证书未签发、或域名的代理开关是灰云（仅 DNS）。");
    console.log("     建议：换手机流量或另一网络再试一次；仍失败就去面板看该主机名的代理状态是否为「已代理」。");
    continue;
  }

  const isOurPage = page.status === 200 && /<script id="cfg"[^>]*>/.test(page.body);
  console.log(`  GET /            : HTTP ${page.status} | ${(page.body.length / 1024).toFixed(1)} KB | ${page.ms}ms`);
  console.log(`     Server        : ${page.headers.get("server") || "（未提供）"} | cf-ray ${page.headers.get("cf-ray") ? "有" : "无"}`);
  console.log(`     是否本站页面  : ${isOurPage ? ok("是") : bad("不是（返回的不是本项目的页面）")}`);
  if (page.headers.get("content-security-policy")) console.log(`     CSP           : ${ok("存在（nonce 策略已生效）")}`);

  const favicon = await httpGet(`${base}/favicon.svg`);
  console.log(`  GET /favicon.svg: HTTP ${favicon.status} | ${favicon.headers.get("content-type") || "-"}  ${favicon.status === 200 ? ok("") : bad("异常")}`);

  const probePath = `/__doctor-${Math.random().toString(36).slice(2, 10)}`;
  const probe = await httpGet(`${base}${probePath}`);
  const emptyBody = probe.body.length === 0;
  console.log(`  GET 随机路径     : HTTP ${probe.status} | body ${probe.body.length} 字节  ${probe.status === 404 && emptyBody ? ok("符合本站特征（空 404）") : bad("不符合本站特征")}`);
  if (probe.status === 404 && !emptyBody) {
    console.log("     含义：请求没进到本项目 Worker（命中别的服务或 CF 默认页）。检查 Worker 路由绑的是不是这个域名。");
  }
  if (probe.status === 200) {
    console.log("     含义：随机路径也返回 200，说明有 SPA/兜底路由抢了请求，本项目的隐藏路径设计未生效。");
  }

  if (isOurPage) {
    const cfgJson = /<script id="cfg"[^>]*>([\s\S]*?)<\/script>/.exec(page.body)?.[1];
    let pageCfg = null;
    try {
      pageCfg = JSON.parse(cfgJson);
    } catch {}
    if (pageCfg?.g) {
      const jump = await httpGet(`${base}${pageCfg.g}`);
      console.log(`  GET 跳转路径     : HTTP ${jump.status} | → ${jump.headers.get("location") || "-"}  ${jump.status === 302 ? ok("") : bad("异常")}`);
      if (cfg.target && jump.headers.get("location") && !jump.headers.get("location").startsWith(cfg.target.replace(/\/$/, ""))) {
        console.log(`     注意：跳转目标与 wrangler.toml 里写的 TARGET_URL(${cfg.target}) 不一致。`);
      }
    }
    if (pageCfg?.v && pageCfg?.k) {
      const visit = await fetch(`${base}${pageCfg.v}`, {
        method: "POST",
        headers: { "x-sig": pageCfg.k, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      const view = visit ? await visit.json().catch(() => null) : null;
      if (view) {
        console.log(`  计数写入         : HTTP ${visit.status} | configured=${view.configured} counted=${view.counted} 总访问=${view.total} 独立访客=${view.uv}`);
        if (view.configured === false) {
          console.log(`     ${warn("统计后端未绑定（COUNTER / VISITS），只跳转不计数")}`);
        }
      } else {
        console.log(`  ${bad("计数写入失败（POST 未返回可解析结果）")}`);
      }
    }
  }

  if (apiSecret) {
    const paths = await derivePaths(apiSecret);
    const reset = adminToken ? "（本机有 ADMIN_TOKEN，可用 /h、/r 自检与清零）" : "（本机没有 ADMIN_TOKEN，跳过运维接口）";
    console.log(`  隐藏路径前缀     : ${paths.prefix} ${reset}`);
    console.log(`     可分享跳转     : ${base}${paths.action.g}`);
    const g = await httpGet(`${base}${paths.action.g}`);
    console.log(`  GET 隐藏跳转     : HTTP ${g.status} ${g.status === 302 ? ok("") : bad("异常 —— 检查 API_SECRET 是否与线上部署一致")}`);
    if (adminToken) {
      const h = await fetch(`${base}${paths.action.h}`, { headers: { "x-admin-token": adminToken }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
      if (h && h.ok) {
        const info = await h.json();
        console.log(`  GET 运维自检     : mode=${info.mode} hardened=${info.hardened} badge=${info.badge} target=${info.target}`);
        if (info.hardened === false) console.log(`     ${warn("线上用的还是默认盐（未配置 API_SECRET），隐藏路径可被推算")}`);
      } else {
        console.log(`  GET 运维自检     : HTTP ${h ? h.status : 0} ${bad("失败 —— 线上 ADMIN_TOKEN 与本机不一致，或该接口未启用")}`);
      }
    }
    const sig = await mintToken(apiSecret, Date.now(), 600);
    console.log(`  本机签名自检     : 已按本机 API_SECRET 生成 ${sig.length} 位签名（线上路径若不一致会体现为上面的 404）`);
  } else {
    console.log(`  隐藏路径前缀     : ${warn("本机没有 API_SECRET（环境变量与 .dev.vars 都没有），跳过隐藏路径检查")}`);
  }
}

console.log("\n================ 结论 ================");
if (notes.length) notes.forEach((n) => console.log(`  ${warn(n)}`));
if (hardFailure) {
  console.log(`  ${bad("存在阻断性故障，站点在公网不可用，请按上面的「修法」处理。")}`);
} else {
  console.log(`  ${ok("未发现阻断性问题：域名已解析、HTTPS 可访问、流量确实进了本站 Worker。")}`);
  console.log("  若你本机仍打不开，基本是本机 DNS/代理问题（例如对某些域名的解析被劫持），换网络或用手机流量验证。");
}

process.exit(hardFailure ? 1 : 0);
