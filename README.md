# cf-visit-gateway

> 一个 Cloudflare Worker 搞定「访客统计 + 跳转网关」：打开页面就计数，点一下就去 `www.yzzx.org`。
> 对外只暴露 `/`、`/favicon.svg`、`/naiwa.jpg` 三个公开资源，所有接口都藏在**密钥派生的不可猜路径**下，且客户端**拿不到任何密钥**。

![License](https://img.shields.io/badge/license-MIT-blue)
![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020)
![Storage](https://img.shields.io/badge/storage-Durable%20Objects-4f46e5)
![Secrets](https://img.shields.io/badge/client--side%20secrets-none-34d399)

零运行时依赖、零前端构建：整个站点（HTML + CSS + JS）内联在 Worker 里，`npm run deploy` 一次就是完整线上服务。

---

## 它做什么

```
访客 ──GET / ──────────────► 统计页（独立访客 / 总访问 / 今日 / 跳转次数 / 近 7 天柱状图）
                             │ 页面用「时间窗签名」POST 到 /<prefix>/v 计入一次访问
                             ▼
       点击「立即前往」──GET /<prefix>/g ──► 计入跳转次数 ──302──► https://www.yzzx.org
```

除 `/` 与两个静态资源（`/favicon.svg`、`/naiwa.jpg`）外，**其余一切路径都返回完全相同的空 404**：没有 `/api/*`、没有 `/healthz`、没有 `/badge.svg`、没有 `/go`。

## 特性

- **接口全隐藏**：所有端点路径由 `HMAC(API_SECRET, 固定盐)` 派生，前缀不可猜、可轮换；旧式 `/api/visit` 这类路径根本不存在，字典爆破与指纹扫描拿不到任何东西。
- **客户端零密钥**：页面里注入的是「按 10 分钟时间窗轮换的 HMAC 签名」，不是密钥；签名无法反推密钥，且过期即失效。
- **失败不可区分**：错路径、无签名、假签名、跨源、错令牌、内部异常——全部返回逐字节相同的空 404，不构成探测预言机。
- **严格 CSP**：页面响应带 nonce 化的 `default-src 'none'` 策略，注入脚本会被浏览器直接拦掉。
- **计数精确**：Durable Object 全局单实例，Cloudflare 天然串行化同实例请求，不存在「读-改-写」丢计数。
- **防刷量**：UV 12 小时去重、同 IP 1.2 秒节流、跳转与访问分开计数。
- **无 JS 也能用**：跳转就是服务端 302，分享链接、爬虫、`curl` 都正常。
- **密钥泄露自检**：`npm run audit` 机械扫描仓库、配置与构建产物，堵住「把 secret 贴进 README / 代码 / .dev.vars 并提交」。
- **自动降级**：绑了 Durable Object 用精确模式；只绑 KV 用近似模式；都没绑也照常跳转，只是不显示假数字。

## 密钥纪律

| 密钥 | 用途 | 下发方式 | 客户端可见？ |
| --- | --- | --- | --- |
| `API_SECRET` | 派生隐藏路径前缀 + 派生客户端签名盐 | `npx wrangler secret put API_SECRET` | 否，永不出现 |
| `ADMIN_TOKEN` | 清零统计、运维自检 | `npx wrangler secret put ADMIN_TOKEN` | 否，只走服务端请求头 |

三条硬规矩：

1. 密钥**只**来自 `env`/secret，不写进 `wrangler.toml`、不进仓库、不进构建产物、不进日志、不进任何响应体或响应头。
2. 页面拿到的是签名而不是密钥；签名泄露只意味着「最多可以刷 10 分钟计数」，不能读库、不能清零、不能反推密钥。
3. 未配置 `API_SECRET` 时程序仍可用，但路径退化为公开默认盐（仅混淆强度），Worker 日志会打印一次告警提示加固。

## 快速开始

```bash
npm install
npx wrangler login

# 生成两个随机密钥并写进 Cloudflare（值不会落到本地文件、不会进仓库）
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"   # ① API_SECRET
npx wrangler secret put API_SECRET
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"   # ② ADMIN_TOKEN
npx wrangler secret put ADMIN_TOKEN

npm run deploy      # 部署
npm run paths       # 本地推导并打印隐藏路由表 + 可分享链接
```

首次部署会自动按 `wrangler.toml` 的迁移建好 Durable Object 命名空间（`new_sqlite_classes`，满足[新命名空间必须使用 SQLite 后端](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)的要求）。

> `npm run paths` 需要本机能读到 `API_SECRET`：可以用环境变量，或建一个 `.dev.vars`（已在 `.gitignore` 中，本地开发也用它）。

### 方式二：GitHub Actions 自动部署

仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 取值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API Tokens 里用 **Edit Cloudflare Workers** 模板创建 |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard 右侧栏的 Account ID |
| `API_SECRET` | 随机串（工作流会把它作为 Worker secret 推送，不写进仓库） |
| `ADMIN_TOKEN` | 随机串 |

push 到 `main` 后工作流会依次跑测试 → 密钥审计 → 推送 secret → 部署。

### 方式三：纯网页操作（不需要命令行）

```bash
npm run build:single
```

把 `single-file/worker.js` 全文粘进 Dashboard 的 Worker 在线编辑器，创建 KV 命名空间并以 `VISITS` 为变量名绑定，再在「设置 → 变量」里添加 `API_SECRET`（类型选 **Secret**）与 `ADMIN_TOKEN`。

> 单文件版只能用 KV 后端（近似计数），因为面板无法配置 Durable Object 迁移。要精确计数请用方式一或二。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TARGET_URL` | `https://www.yzzx.org` | 跳转目标。只接受 `http/https`，其它协议自动回退默认值，防止被配成 `javascript:` 之类 |
| `SITE_TITLE` | `本站访客统计` | 页面标题 |
| `TZ_OFFSET` | `8` | 统计「今日 / 近 7 天」所用时区偏移（小时），8 = 北京时间 |
| `AUTO_REDIRECT` | `0` | 大于 0 时页面倒计时 N 秒自动跳转；0 = 只响应点击 |
| `MIN_INTERVAL_MS` | `1200` | 同一 IP 的最小计数间隔（毫秒），防手抖刷新刷量；0 = 关闭节流 |
| `ENABLE_BADGE` | `false` | 是否开放隐藏路径下的徽章接口（开启等于公开只读计数） |
| `API_SECRET` | 无 | **用 secret 下发**。隐藏路径与客户端签名的盐 |
| `ADMIN_TOKEN` | 无 | **用 secret 下发**。未配置时清零与自检接口整体关闭 |

## 隐藏路由表

`npm run paths` 会按你本机的 `API_SECRET` 打印实际路径。约定如下（`{prefix}` 为 16 位派生十六进制串）：

| 路径 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/` | GET | 公开 | 统计页，唯一入口 |
| `/favicon.svg` | GET | 公开 | 站点图标 |
| `/naiwa.jpg` | GET | 公开 | 首页顶部的圆形奶蛙头像（512×512 JPEG，约 26 KB，缓存 1 天） |
| `/{prefix}/g` | GET | 仅前缀 | 302 到目标站并计入跳转次数；**这是唯一可对外分享的隐藏路径** |
| `/{prefix}/v` | POST | 前缀 + 签名 | 记录一次访问；**只返回位次相关字段**（`uv` / `first` / `configured` / `counted`） |
| `/{prefix}/s` | GET | 前缀 + 签名 | 读取位次（同样只给 `uv`，不下发其它计数） |
| `/{prefix}/c` | POST | 前缀 + 签名 | 单独记录跳转 |
| `/{prefix}/b` | GET | 仅前缀 | 徽章（需 `ENABLE_BADGE=true`） |
| `/{prefix}/r` | POST | 前缀 + 令牌 | 清零统计，需 `x-admin-token` |
| `/{prefix}/h` | GET | 前缀 + 令牌 | 运维自检 + **完整计数**（总访问 / 今日 / 跳转 / 独立访客） |
| 其它任何路径 | — | — | 空 404 |

浏览器能拿到的只有位次（`/{prefix}/v` 与 `/{prefix}/s` 的响应）：

```json
{ "configured": true, "counted": true, "uv": 321, "first": 1792071702200 }
```

总访问、今日、跳转次数、每日明细**不会下发给浏览器**——即使打开 devtools 也看不到。需要看全量时用带令牌的运维接口：

```bash
curl -s https://<你的域名>/<prefix>/h -H "x-admin-token: <ADMIN_TOKEN>"
# -> { "mode": "durable", "stats": { "total": 1024, "uv": 321, "today": 42, "clicks": 87 } }
```

## 域名打不开？先跑一次体检

```bash
npm run doctor                  # 自动读 wrangler.toml 里 [[routes]] 的域名
npm run doctor -- heyiwei.asia  # 或手动指定（可传多个）
npm run doctor:ca               # 本机有 TLS 检查代理（报 UNABLE_TO_VERIFY_LEAF_SIGNATURE）时用这个
```

它从外部逐层判定，把故障**归因到具体一层**并给出对应修法：

| 体检项 | 判读 |
| --- | --- |
| A/AAAA/CNAME | 主机名是否解析、是否指向 Cloudflare 边缘地址段 |
| 权威 NS | zone 是否已托管在 Cloudflare——用于区分「域名没接入」与「主机名没绑定」 |
| DoH 交叉验证 | 本机 DNS 可疑时，用 Cloudflare / Google / AliDNS / 360 四家 DoH 交叉核对 |
| `GET /` | 状态码、是否真的是本项目页面、CSP 是否生效、cf-ray 是否存在 |
| `GET /favicon.svg` | 静态资源是否被 Worker 处理 |
| `GET 随机路径` | 必须返回**空 body 的 404**；若返回带 body 的 404 或 200，说明流量没进本项目 Worker |
| 跳转路径 | 是否 302 到 `TARGET_URL` |
| 计数写入 | 带签名 POST 后的 `configured` / `counted` / 总数 |
| 隐藏路径（可选） | 本机能读到 `API_SECRET` 时，核对该部署的派生前缀，并提示是否仍在用默认盐 |

判定纪律：DNS 查不到记录时**不会直接下结论**，而是再发一次 HTTPS 请求——直连能通就说明是本机解析滞后，报告为警告而非故障。

### 实例：`heyiwei.asia` 从打不开到可用（已修复）

修复前的体检结论：

```
heyiwei.asia      A/AAAA : （无记录）  权威 NS : june / lochlan.ns.cloudflare.com  ✓ 已托管在 Cloudflare
www.heyiwei.asia  A/AAAA : （无记录）  ENOTFOUND
结论：域名已经交给 Cloudflare 托管，但没有任何主机名绑定到 Worker —— 浏览器在 DNS 阶段就失败
```

根因就是少了主机名绑定，加上 `wrangler.toml` 里那两段 `[[routes]]`（裸域与 www 是两个主机名，必须各绑一次）后重新部署，同一脚本的结论变成：

```
================ heyiwei.asia ================
     边缘判断: ✓ 解析到 Cloudflare 边缘地址段
  GET /            : HTTP 200 | 12.7 KB | 是否本站页面 ✓ | CSP ✓
  GET 随机路径     : HTTP 404 | body 0 字节  ✓ 符合本站特征（空 404）
  GET 跳转路径     : HTTP 302 | → https://www.yzzx.org/  ✓
  计数写入         : HTTP 200 | configured=true counted=true
  GET 运维自检     : mode=durable hardened=true target=https://www.yzzx.org/
================ 结论 ================
  ✓ 未发现阻断性问题：域名已解析、HTTPS 可访问、流量确实进了本站 Worker。
```

`npm run deploy` 之后 Cloudflare 会自动创建代理 A/AAAA 记录并签发证书。三种典型失败：

- **报记录冲突**：该主机名上已有 A/AAAA/CNAME 记录，先删掉冲突记录，或改用面板 Worker → Settings → Domains & Routes → Add custom domain。
- **报找不到 zone**：该域名不在当前 Cloudflare 账号（或 NS 尚未生效）。Worker 与域名必须在同一账号。
- **部署成功但刚打开没反应**：新建自定义域名后解析需要传播，且本机 DNS 可能还在用负缓存，等 1–2 分钟重跑 `npm run doctor`；脚本会优先用 HTTPS 直连交叉验证，不会把这种滞后误判成故障。
- **部署报「More than one account available」**：账号下有多个 Cloudflare 账号（例如残留的 `--temporary` 临时预览账号）时非交互模式无法自选，已在 `wrangler.toml` 用 `account_id` 固定，换账号改这一行即可。

不想用自定义域名就把这两段删掉，`workers.dev` 地址照常可用；GitHub Actions 在部署后会自动跑一次体检并在日志里输出同样的结论。

## 这套隐藏能挡住什么，挡不住什么

诚实的边界（这决定了防护该放在哪一层）：

- **藏住了**：接口形状、扫描器与字典爆破（路径不可猜）、指纹识别（旧 `/api/*` 已不存在）、密钥（客户端只有签名）。
- **藏不住的**：把页面源码抄走的定向攻击者——他必然能看到自己浏览器要用的「记访问路径 + 当前签名」，这是浏览器计数的固有代价。
- **因此真正兜底的是**：签名 10 分钟过期、同源校验（跨站请求直接 404）、IP 节流、UV 去重、以及「危险操作（清零/自检）必须带只存在于服务端的令牌」。
- **攻击者的收益上限**：刷一刷访问数；读不到密钥、拿不到访客哈希、清不了库、改不了跳转目标。

## 在 README 里挂徽章

徽章默认关闭。确认要公开只读计数后，设 `ENABLE_BADGE=true` 并部署，然后按 `npm run paths` 打印的路径引用：

```markdown
![visitors](https://<你的域名>/<prefix>/b)
![visits](https://<你的域名>/<prefix>/b?metric=total)
![今日](https://<你的域名>/<prefix>/b?metric=today&label=今日)
```

支持 `metric=uv|total|today|clicks`，`label` 可自定义 1–20 个字符。

## 运维：清零与自检

```bash
npm run paths    # 打印前缀与可直接粘贴的 curl 命令
curl -s https://<你的域名>/<prefix>/h -H "x-admin-token: <ADMIN_TOKEN>"
curl -s -X POST https://<你的域名>/<prefix>/r -H "x-admin-token: <ADMIN_TOKEN>"
```

未配置 `ADMIN_TOKEN` 时这两个接口整体关闭；令牌不符时返回与「路径不存在」完全相同的 404；校验使用定长逐字符比较，避免计时侧信道。

## 密钥泄露自检

```bash
npm run audit
```

四类检查，任一处命中即退出码 1：

1. 已知密钥形态：私钥块、GitHub / Slack / OpenAI / AWS / Google / JWT 令牌、以及 `API_SECRET = "…"` 这类硬编码赋值。
2. 真实密钥值比对：把环境变量里 `API_SECRET` / `ADMIN_TOKEN` / `CLOUDFLARE_*` 的当前值，在全仓库逐个文件搜索——这条最实用，能拦住「secret 被贴进 README / 代码 / .dev.vars 并提交」。
3. 客户端内容检查：`src/page.html` 与构建产物里内联的页面片段，不得出现密钥变量名。
4. 卫生检查：`wrangler.toml` 不得硬编码密钥；`.gitignore` 必须覆盖机密文件；git 索引里不得存在 `.dev.vars` / `.env` / `*.pem` / `*.key`。

可加料：`VG_AUDIT_SECRETS="额外要搜的值" npm run audit`。

## 首页头像素材

`assets/naiwa.jpg` 是首页顶部那个 190px 圆形头像，384×384、约 16 KB，由 Worker 从固定公开路径 `/naiwa.jpg` 按原字节提供（`Cache-Control: max-age=86400`），不在客户端产生任何外链请求。

- 素材来源：社区素材仓库 [Nailong-Studio/wallpaper](https://github.com/Nailong-Studio/wallpaper)（MIT）里的 `4k/thumbs/奶蛙-4K-抱头震惊-02.jpg`，裁剪依据是可量化指标而非肉眼——该图在这批候选里主体最居中（深色轮廓质心相对画面中心仅偏 2.3% / 4.9%），圆形裁切最不容易切到本体。
- 奶蛙是官方角色「奶龙」的民间衍生形象。仓库代码是 MIT，但角色美术的可用性需你自行确认；对外公开使用前请自行判断授权。
- 想换成你自己的图：直接把图片覆盖到 `assets/naiwa.jpg`（建议正方形，≥384×384），然后 `npm run deploy`。页面里还留了一层内联 SVG 兜底，图片加载失败时不会出现破图。
- 想换姿势：`Nailong-Studio/wallpaper` 里还有 5 张 4K 姿势（捶头大笑 / 抱头震惊 / 叉腰指点 / 托腮沉思 / 张臂平衡），说一声我按同一套指标重新裁一张。
## 数据与隐私

Durable Object 里只有一个 JSON 记录：

```json
{ "v": 1, "first": 1792071702200, "last": 1792071719115,
  "total": 1024, "uv": 321, "clicks": 87,
  "days": { "2026-10-15": 42 },              // 只留最近 14 天
  "seen": { "2a8dbaab…": 1792071702200 } }    // 去重窗口内的指纹，会自动过期
```

- 访客标识是一枚随机 Cookie（`_vid`，HttpOnly + Secure + SameSite=Lax，1 年），**入库的只是它 SHA-256 前 16 字节的哈希**，原文不离开浏览器。
- IP 只用于进程内存里的节流判断，不落库、不进日志。
- 页面无外链资源，无第三方 SDK，内网 / 离线环境同样可渲染。

## 免费额度参考

Workers Free 每天 10 万次请求；Durable Objects 已向 Free 计划开放（[官方公告](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/index.md)），Free 计划只支持 SQLite 后端的 DO。KV 免费额度为每天 10 万次读 / 1000 次写，且同一 key 每秒只能写一次——这正是默认走 DO 而不是 KV 的原因。具体数字以 [定价页](https://developers.cloudflare.com/workers/platform/pricing/) 为准。

## 本地开发

```bash
npm run dev            # 本地 workerd，含真实 SQLite 版 Durable Object
npm test               # 22 个零依赖用例
npm run audit          # 密钥泄露自检
npm run paths          # 打印隐藏路由表与 curl 命令
npm run check          # wrangler 干跑构建（校验配置与打包）
npm run build:single   # 重新生成面板粘贴版单文件
```

本地开发请复制 `.dev.vars.example` 为 `.dev.vars`（已在 gitignore 中）：

```bash
cp .dev.vars.example .dev.vars     # 然后填入两个随机串
```

本地状态落在 `.wrangler/state/v3`（已 gitignore），删掉该目录即清空本地计数。

## 项目结构

```
.
├── assets
│   └── naiwa.jpg     首页头像素材（社区素材仓库 Nailong-Studio/wallpaper 的奶蛙-4K-抱头震惊-02）
├── src
│   ├── index.js      Worker 入口：路由分发、隐藏路径匹配、鉴权、渲染、404 折叠
│   ├── secret.js     密钥派生：隐藏前缀、时间窗签名、定长比较、随机串
│   ├── store.js      后端选择：durable / kv / none，统一 visit·click·stats·reset
│   ├── durable.js    Durable Object 计数器（blockConcurrencyWhile + 写穿持久化）
│   ├── stats.js      纯函数状态机：归一化、记录、去重、裁剪、视图
│   └── page.html     静态界面（内联 CSS/JS，CSP nonce，只带签名不带密钥）
├── single-file/
│   └── worker.js     面板粘贴版（由 scripts/build-single.mjs 生成，请勿手改）
├── scripts
│   ├── build-single.mjs   打包单文件版
│   ├── audit-secrets.mjs  密钥泄露自检
│   ├── doctor.mjs         部署体检：DNS/HTTP/页面/计数逐层归因
│   └── paths.mjs          本地推导隐藏路由表
├── test
│   ├── run.mjs       22 个用例：状态机 + DO + 隐藏路由 + 鉴权 + 不可区分性 + 密钥不泄露 + 静态资源
│   └── html-loader.mjs  让 Node 能 import '.html'（Text 规则）与 '.jpg'（Data 规则）
├── wrangler.toml     部署配置、自定义域名 routes、变量、DO 绑定与迁移（不含任何密钥）
├── .github/workflows/deploy.yml   测试 + 审计 + 部署
├── .dev.vars.example  本地密钥模板（真实值写在 .dev.vars，已被忽略）
├── .editorconfig / .gitattributes  缩进与换行符统一
└── .gitignore        含机密文件模式
```

## 常见问题

**为什么 `/api/visit`、`/healthz`、`/go` 都没了？** 这是刻意的：对外只留 `/` 和一个可分享的隐藏跳转路径，其余路径返回相同空 404，接口形状不可探测。

**别人从页面源码里看到路径和签名怎么办？** 他最多能刷 10 分钟计数——这就是防护上限，也是浏览器计数无法避免的代价；密钥、访客哈希、清零能力都不在客户端。详见「这套隐藏能挡住什么」。

**怎么知道自己的隐藏路径？** `npm run paths`（本地按 `API_SECRET` 推导），自检接口 `/{prefix}/h` 也会返回可分享链接。

**刷新页面数字为什么不涨？** 间隔小于 `MIN_INTERVAL_MS`（默认 1.2 秒）会被合并，这是防刷新刷量；设为 `0` 可关闭。

**同一个人多次访问，独立访客为什么只涨一次？** UV 去重窗口是 12 小时；「总访问」每次都会涨。

**并发高时会丢计数吗？** `durable` 模式不会（所有请求进同一 DO 实例串行处理）。`kv` 回退模式是读-改-写，高并发下会漂移。

**绑自己的域名？** `wrangler.toml` 里已经写好了 `heyiwei.asia` 与 `www.heyiwei.asia` 的 `custom_domain` 路由，`npm run deploy` 即可；换成你的域名就改这两段的 `pattern`。打不开时先 `npm run doctor`，排查流程见上文「域名打不开」。

## License

[MIT](./LICENSE)
