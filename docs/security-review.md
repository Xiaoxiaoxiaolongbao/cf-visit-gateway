# 江苏省奶蛙中学.com 安全评估报告

> 评估对象：`https://江苏省奶蛙中学.com`（Cloudflare Worker `cf-visit-gateway`）
> 评估视角：外部攻击者（未持有管理员凭据、未接触源码之外的内部信息）
> 评估时间：2026-10-25
> 授权状态：资产所有者为本人，本次为授权自测

---

## 一、结论

| 项 | 数量 |
| --- | --- |
| 攻击面检查项 | 24 |
| **发现并已修复的问题** | **7**（含 1 项信息泄露、1 项封禁绕过、1 项会话吊销缺陷） |
| 修复后仍然守住 | 18 |
| 建议接受（不修）的风险 | 6 |

修复前：`守住 17 / 问题 2`；修复后：`守住 18 / 问题 0`。
高危问题（认证绕过、任意读写、RCE、SQL 注入、存储型 XSS 执行）**一项都没有打穿**。

---

## 二、攻击面清单

| 入口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /` | 公开 | 首页，内嵌签名与隐藏路径 |
| `GET /admin` | 公开（页面） | 管理台页面，CSP nonce + noindex |
| `/admin/api/*` | passkey 会话 | 列表、删除、拉黑、私信回复、密钥管理 |
| `GET /api/wall` | 公开 | 弹幕与图片列表 |
| `POST /api/wall/danmaku` | 公开 | 发弹幕（限流） |
| `POST /api/wall/upload` | 公开 | 传图（限流 + 魔数校验） |
| `POST/GET /api/wall/message` | 公开 | 私信投递 / 凭码查询回复 |
| `GET /img/<id>` | 公开 | 取图（KV） |
| `GET /gallery/1..6.jpg`、`/naiwa.jpg`、`/favicon.*` | 公开 | 静态资源 |
| `/{prefix}/{v,s,c,g,r,h,b}` | 前缀 / 签名 / 令牌 | 计数与运维接口，路径由 HMAC 派生 |
| `mail.*` 子域 | 公开 | 邮箱入口页 |

技术栈：Worker（无框架）+ Durable Object（SQLite）+ KV + WebAuthn（自实现校验）。

---

## 三、发现的问题（全部已修复）

### 1. 匿名可读取 passkey 清单（信息泄露 · 中）

`GET /admin/api/session` 在未登录时仍返回 `passkeys` 数组，其中 `name` 字段是注册时的**浏览器 UA 字符串**，等于把管理员的设备指纹与凭据数量公开。

证据（修复前）：

```
✗ 匿名可读 passkey 清单 ← 1 条，含名称（UA）：Mozilla/5.0 (Windows NT 10.0; Win64; x64…
```

修复：未登录只返回 `passkeyCount`（数量），`passkeys` 置空；前端改用计数判断状态。
修复后：`{"authed":false,…,"passkeyCount":1,"passkeys":[]}`。

### 2. 缺少 HSTS（降级攻击面 · 中）

所有响应都没有 `Strict-Transport-Security`，首次访问存在被 SSL-strip 的窗口。

修复：`/`、`/admin`、`/gallery/*`（以及 `mail.` 页）统一返回
`max-age=31536000; includeSubDomains`。浏览器获得任一响应即缓存策略。

### 3. 会话 MAC 使用非常量时间比较（时序侧信道 · 低）

`unsign()` 里用 `mac !== expect` 比较 HMAC，理论上可按字节推断。Worker 环境下可利用性很低，但成本几乎为零。

修复：新增 `timingSafeEqualStr()`（逐字节 XOR 累积），比较改为常量时间。

### 4. 管理写接口缺少 Origin 校验（CSRF 纵深 · 中）

会话 Cookie 是 `SameSite=Lax`，已能挡掉多数跨站 POST，但没有任何显式的来源校验。

修复：`/admin/api/*` 的所有非 GET 请求，若带 `Origin` 且不属于本站（含 `www.`）直接 403
「跨站请求被拒绝」；无 `Origin` 的非浏览器客户端（脚本/运维）不受影响。

### 5. 登出只清 Cookie，旧 Cookie 仍有效（会话吊销缺陷 · 中）

会话是无状态 HMAC Cookie，`/logout` 仅把浏览器里的值清空——**一旦 Cookie 被窃取，12 小时内仍可继续使用**。

修复：引入吊销点位 `logoutEpoch`（存 Vault `meta` 表）。会话里带 `iat`，校验时若 `iat < logoutEpoch` 立即失效；`/logout` 把点位抬到当前时间并清 Cookie。吊销点有 30 秒隔离域缓存，避免每个管理请求都打一次 Durable Object。

### 6. 黑名单可被 IPv4 映射地址绕过（封禁绕过 · 中）

拉黑按原始 IP 字符串精确匹配。同一台机器用 `::ffff:203.0.113.9` 访问，与 `203.0.113.9` 被当作两个来源，封禁失效。

修复：新增 `normIp()`——去 `::ffff:` 前缀、去空白、转小写；入库与比对两端统一使用。

### 7. 图片没有像素上限（解压炸弹 · 中）

上传只校验 10MB 体积与文件魔数。一个几十 KB 的 PNG 可以声明 30000×30000，任何打开页面的访客浏览器都会尝试解码约 9 亿像素。

修复：新增 `imageSize()`，从文件头解析 PNG / GIF / WebP(VP8X) / JPEG(SOF) 的真实宽高，
超过 **4000 万像素**直接 413；解析不出尺寸时不误杀。

---

## 四、已验证守住的攻击（18 项）

| 攻击 | 结果 |
| --- | --- |
| 管理接口未授权访问（9 个端点逐一打） | 全部 401/403，无数据泄露 |
| 伪造会话 Cookie（空盐 / 默认盐 / 组合盐三种） | 全部被拒 |
| 伪造 WebAuthn challenge 注册 | 403 |
| 已有 passkey 后使用管理令牌 | 401（令牌通道已关） |
| 公开接口泄露 IP / 双指纹 | 无（13 条样本检查） |
| 敏感文件探测（`/.dev.vars`、`/.env`、`/.git/config`、`/wrangler.toml`、`/src/index.js`） | 全部空 404 |
| 弹幕颜色/字号注入（`red;background:url(//evil)`、`999`） | 规范化为 `#f5f5f7` / 28px |
| 存储型 XSS（`<img onerror>`、`</script>`） | 服务端按文本存储，前端全部用 `textContent` 渲染 |
| JPEG+HTML polyglot 上传 | 按 `image/jpeg` 返回 + `nosniff`，不执行 |
| SVG 上传（`onload=alert`） | 415 拒绝 |
| 超过 10MB 上传 | 413 |
| 弹幕刷屏 | 连续发送触发 429 |
| 用 GET 打删除接口 | 401，不接受 |
| CSP | `default-src 'none'` + nonce，无 `unsafe-inline` |
| `X-Content-Type-Options` / `Referrer-Policy` / `frame-ancestors` | 均存在 |
| 子域枚举 | 仅 `www`、`mail`，无悬挂 CNAME / 子域接管面 |
| 前端密钥泄露 | `npm run audit` 干净 |
| 会话 Cookie 属性 | `HttpOnly` + `Secure` + `SameSite=Lax` |

---

## 五、建议接受的风险（有理由，非疏漏）

1. **EXIF 未剥离**：Worker 里没有图像编解码器（不会为了这件事塞一个 50KB 的 wasm），上传图的 GPS/设备信息会原样保留。缓解：上传确认窗提示，或用户自行去元数据。
2. **指纹只记录不拦截**：这是产品决策（"仅记录对比"）。它可被用来跨 IP 关联同一来源，但没有强制力。
3. **隐藏路径前缀会随首页下发**：`/v`、`/s` 与 10 分钟签名就写在页面 JSON 里，任何人都能取到。防的是扫描器与爬虫，不是人类访客；UV 仍受 IP 限流与 Cookie 去重约束。
4. **IPv6 轮换可绕限流与黑名单**：`/64` 内换地址就是新 IP。归一化只解决了 IPv4 映射前缀；彻底方案需要按 `/64` 聚合，代价是会误伤共用出口的网络。
5. **`*.workers.dev` 可能是第二条入口**：本地网络不可达无法确认。若可达，会绕过只挂在自定义域名上的规则（鉴权不受影响，鉴权在 Worker 内部）。缓解：Cloudflare 后台可关闭 workers.dev 路由。
6. **单实例 Durable Object 是计数与内容的单点**：免费额度下没有跨区冗余，异常时读写会短暂失败（前端已有降级提示）。

---

## 六、复现方式

```bash
# 攻击面自测（只读 + 无破坏性写入）
node .toolchains/attack-audit.mjs

# 输出：逐项 OK / FINDING / INFO，最后一行给统计
# 修复前：守住 17 项 | 问题 2 项
# 修复后：守住 18 项 | 问题 0 项
```

新增的自动化回归（`test/wall.mjs`，共 21 例）覆盖了本次修复：

- 会话接口不向匿名者泄露 passkey 明细
- 像素炸弹（30000×30000 PNG）返回 413
- IP 归一化：`::ffff:203.0.113.9` 与 `203.0.113.9` 视为同一来源
- 管理写接口拒绝跨站 Origin

---

## 七、修复清单

| 提交 | 内容 |
| --- | --- |
| `feat: 会话接口收敛 / HSTS / 常量时间 MAC / Origin 校验` | 问题 1–4 |
| `feat: IP 归一化 / 图片像素上限 / 会话吊销` | 问题 5–7 |
| `test: 补 4 个安全回归用例` | 与测试同上 |

> 说明：本次评估仅覆盖网络层与业务逻辑层。未做的事项，避免夸大结论：真实 Level 3/4 网络攻击、Cloudflare 账号侧（Worker Secret、DNS、Zone 权限）的评估、供应链（npm 依赖）代码审计，都需要另外的授权范围与工具链。
