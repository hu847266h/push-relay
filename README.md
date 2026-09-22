# Push Relay

> **One webhook in, many push platforms out.**
> 一个 Webhook 入口，把同一条通知**并发扇出**到多个推送渠道 —— 跑在 Cloudflare Workers 上，无服务器、零依赖、单文件。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Tests](https://img.shields.io/badge/tests-109%20passed-brightgreen)](#本地开发与测试)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 为什么需要它

很多工具和服务**只允许填一个通知地址**，或者一次只能选一个推送渠道。于是你会遇到：

- 想手机上（Bark）、群里（企业微信/钉钉/飞书）**同时**收到，只能二选一
- 换了工具就得重配一遍推送，密钥散落在各处
- 某个渠道抽风时**完全不知道**通知有没有发出去
- 想在 Discord / Telegram 也留一份，但那个工具不支持

Push Relay 在中间加一层：**发送端只认一个地址**，真正的投递目标由后端配置决定。

```
       任何发送端                        Push Relay (Cloudflare Worker)
┌───────────────────────┐          ┌──────────────────────────────────┐
│ 三月七小助手 / 监控告警 │          │  POST /push/<PUSH_SECRET>        │
│ CI 流水线 / 定时脚本    │  POST    │        │                         │
│ 自建服务的 Webhook     │ ───────► │        ├─► 企业微信机器人 (含图) │
│ curl / requests       │  任意格式 │        ├─► 钉钉 / 飞书 机器人     │
└───────────────────────┘          │        ├─► Bark / Telegram        │
                                   │        ├─► Discord / ntfy         │
                                   │        ├─► Server酱 / PushPlus…   │
                                   │        └─► 通用转发（任意 HTTP）  │
                                   │                ▼                 │
                                   │  逐目标结果 + 日志 + 图片临时托管 │
                                   └──────────────────────────────────┘
```

## 特性

- **15 类推送渠道**：企业微信（机器人/应用）、钉钉、飞书、Bark、Telegram、Discord、Server酱（Turbo/³）、PushPlus、PushDeer、Gotify、ntfy、WxPusher，外加一个万能「通用转发」。
- **入站载荷自适应**：JSON、multipart 表单、urlencoded、纯文本、GET 查询参数全认。发送端**通常什么都不用改**。
- **图片全链路**：支持直接上传图片的渠道走原生上传；只吃图片 URL 的渠道自动转成临时托管链接；「通用转发」还能拿到 base64。
- **并发扇出 + 逐目标结果**：一个渠道挂了不影响其它渠道，返回体里单独标出失败原因（平台原始错误原样带出，方便排查）。
- **图形控制台**：在线增删改目标、一键测试投递、查看最近推送记录。配置和日志存 KV，**改完即生效，不需要重新部署**。
- **单文件、零运行时依赖**：`src/index.js` 一个文件就是全部后端，含纯 JS 实现的 MD5（企业微信图片消息要求）和 HMAC-SHA256（钉钉加签）。
- **自带鉴权**：推送地址带密钥，控制台带管理口令，密钥只存在你自己的 KV 里。

## 快速开始

### 方式一：wrangler（推荐）

```bash
git clone https://github.com/hu847266h/push-relay.git
cd push-relay
npm install

# 1. 建 KV，把输出的 id 填进 wrangler.toml
npx wrangler kv namespace create KV

# 2. 设置两个密钥
npx wrangler secret put PUSH_SECRET    # 推送地址里的口令，随便一串随机字符
npx wrangler secret put ADMIN_TOKEN    # 控制台登录口令

# 3. 部署
npx wrangler deploy
```

部署完会输出一个 `https://<worker名>.<你的子域>.workers.dev` 地址。

### 方式二：Cloudflare 控制台手动部署

1. **建 KV**：`Workers & Pages` → `KV` → `Create namespace`，名字如 `push-relay`
2. **建 Worker**：`Workers & Pages` → `Create application` → `Create Worker`，命名后 `Deploy`
3. **粘代码**：进该 Worker → `Edit code`，把 [src/index.js](src/index.js) 全文粘进去 → `Deploy`
4. **绑 KV**：`Settings` → `Variables and Secrets` → `KV Namespace Bindings` → 添加，变量名必须是 **`KV`**，选第 1 步建的空间
5. **加密钥**：同一页面 → `Add` → 类型选 `Secret`，分别加 `PUSH_SECRET` 和 `ADMIN_TOKEN`
6. 重新 `Deploy` 使绑定生效

### 部署后自检

```bash
curl https://<你的域名>/health
# {"ok":true,"kv":true,"targets":0,"enabled":0,"secretRequired":true}
```

`kv:false` 说明第 4 步的绑定没生效；`secretRequired:false` 说明 `PUSH_SECRET` 没设上（此时任何人都能往你的地址推东西，**务必设上**）。

### 方式三：绑自己的域名（可选）

在 `wrangler.toml` 里加：

```toml
routes = [
  { pattern = "push.example.com", custom_domain = true }
]
```

## 配置推送目标

打开控制台 `https://<你的域名>/admin`，填入 `ADMIN_TOKEN` 点「载入」：

- **添加目标**：选类型 → 表单按类型自动生成需要的字段 → 保存
- **测试**：每个目标有独立「测试」按钮，会真发一条测试消息，并把平台返回的错误原样显示
- **停用**：临时关掉某个目标但保留配置（不参与扇出）
- **日志**：每次推送记录标题、正文、是否带图、逐目标成败

## 支持的目标平台

| 类型 | 需要准备 | 图片 |
|---|---|---|
| 企业微信机器人 | 群机器人 Webhook 地址 | ✅ 原生（base64 + md5） |
| 企业微信应用 | corpid / corpsecret / agentid / touser | ✅ 先传素材再发 |
| 钉钉机器人 | Webhook 地址（+ 加签密钥，若安全设置选了「加签」） | ✅ 转图片链接内嵌 markdown |
| 飞书机器人 | Webhook 地址（+ 签名校验密钥） | ➖ 仅文字 |
| Bark (iOS) | device key（可自建服务地址） | ✅ 转图片链接 |
| Telegram | Bot Token + chat_id（可选 thread_id） | ✅ sendPhoto |
| Discord | Webhook URL | ✅ 文件上传 |
| Server酱·Turbo | SendKey | ➖ |
| Server酱³ | 完整发送地址 | ➖ |
| PushPlus | Token（可选 topic / 模板） | ➖ |
| PushDeer | PushKey（可自建） | ➖ |
| Gotify | 服务地址 + 应用 Token | ➖ |
| ntfy | 服务地址 + Topic（可私有 Token） | ✅ 附件链接 |
| WxPusher | appToken + UID | ➖ |
| **通用转发** | 目标地址 + 可选 Headers / Body 模板 | ✅ 模板占位符 |

> 平台都不支持？用「通用转发」—— 填一个地址加一个 body 模板，就能投递到任意 HTTP 接口。

## 发送端怎么接

把 `https://<你的域名>/push/<PUSH_SECRET>` 填进任何支持自定义 Webhook 的地方即可。

### 入站格式兼容表

| 发送端发来的格式 | 解析结果 |
|---|---|
| `POST` `application/json` `{"title":"…","content":"…"}` | 标题 + 正文 |
| `POST` `multipart/form-data` 字段 `title`/`content` + 文件 `image` | 标题 + 正文 + **图片** |
| `POST` `application/x-www-form-urlencoded` | 同上（无文件） |
| `POST` 纯文本 body | 正文（无标题） |
| `GET` `?title=&content=` | 标题 + 正文（方便浏览器里点着测） |

字段名不挑：`title`/`Title`/`subject`/`msg_title` 都认作标题，`content`/`Content`/`desp`/`message`/`body`/`msg`/`text` 都认作正文；图片字段认 `image`/`Image`/`img`/`file`/`image_base64`（base64 或 data-URI 均可）。

认不出的结构（比如告警系统那种嵌套数组 JSON）会把**原始 JSON 文本**当正文推出去 —— 至少不会丢。想让它变整齐，用「通用转发」的模板，或在前端加一层转换。

### 三月七小助手

[三月七小助手](https://github.com/moesnow/March7thAssistant)是最初的目标场景之一。在 `设置 → 消息推送 → Webhook` 里：

- Webhook 接收地址：`https://<你的域名>/push/<PUSH_SECRET>`
- 请求方法 / Headers / 请求体：**全部留空**
- 其它推送渠道：全部关掉（否则会重复推送）

对应 `assets/config/config.yaml`：

```yaml
notification_enable: true
notify_send_images: true      # 保持默认，本服务能收图

notify_webhook_enable: true
notify_webhook_url: "https://<你的域名>/push/<PUSH_SECRET>"
notify_webhook_method: ""     # 留空 = POST
notify_webhook_headers: ""    # 留空
notify_webhook_body: ""       # 留空
```

> ⚠️ 值得注意的坑：三月七会在**有截图时把请求切换成 `multipart/form-data`**（`notify_send_images` 默认开启）。
> 只处理 JSON 的中转服务会让带截图的通知**整条丢失**。本服务两种格式都处理，这也是它 "入站格式自适应" 的由来。

### 其它发送端

| 来源 | 怎么填 |
|---|---|
| Uptime Kuma | 通知 → Webhook，URL 填推送地址 |
| Grafana / Alertmanager | contact point 选 webhook，URL 填推送地址 |
| GitHub Actions / GitLab CI | 加一步 `curl`（见下方示例） |
| 青龙面板 | 通知设置里的自定义 Webhook |
| 自建服务 / NAS | 直接 POST，或把推送地址当通用 Webhook 目标 |
| 任意脚本 | 见下方示例 |

```bash
# 纯文字
curl -X POST "https://<域名>/push/<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"title":"构建完成","content":"v1.2.3 已发布"}'

# 带图片
curl -X POST "https://<域名>/push/<SECRET>" \
  -F "title=服务器告警" -F "content=磁盘使用率 95%" \
  -F "image=@chart.png"

# 浏览器直接点（GET）
https://<域名>/push/<SECRET>?title=test&content=hello
```

返回示例：

```json
{
  "ok": true,
  "summary": { "total": 3, "ok": 2, "failed": 1 },
  "results": [
    { "name": "我的Bark",  "type": "bark",         "ok": true,  "detail": "文本+图片" },
    { "name": "企微群",    "type": "wecom_bot",    "ok": true,  "detail": "文本+图片" },
    { "name": "钉钉",      "type": "dingtalk_bot", "ok": false, "detail": "{\"errcode\":310000,...}" }
  ],
  "hosted": 1
}
```

## 通用转发（自定义 HTTP）

最灵活的适配器：填一个地址加一个 body 模板，就能投递到任意接口。可用占位符：

| 占位符 | 替换成 | 说明 |
|---|---|---|
| `{title}` | 通知标题 | |
| `{content}` | 通知正文 | |
| `{text}` | 标题 + 换行 + 正文 | 含换行，**别放进 JSON 字符串里**（会让 JSON 非法，服务会直接报错拦下） |
| `{image}` | 托管图片地址 `https://<域名>/i/xxx.png` | 只有模板里真写了 `{image}` 才触发图片托管 |
| `{image_base64}` | 图片 base64 | 大图会明显增大请求体，用不到就别写 |
| `{image_name}` | 上传时的文件名 | |

Body 模板**留空**时发默认 JSON：`{"title":…,"content":…,"image_url":…}`（`image_url` 在收到图片时自动带上，可关）。

```jsonc
// 例：字段名对不上就用模板自己拼
{"msg": "{title}: {content}", "img": "{image}"}
```

> 目标接口要求 JSON 时，模板渲染结果会被**预校验**：如果标题里的引号/换行把 JSON 破坏了，会直接返回明确错误而不是把非法载荷发出去。

## 图片是怎么处理的

| 平台类型 | 处理方式 |
|---|---|
| 企微机器人 / 企微应用 / Telegram / Discord | **原生上传**：图片字节直接随请求发出 |
| 钉钉 / Bark / ntfy / 通用转发 | **转托管链接**：图片临时存 KV，以 `https://<域名>/i/<随机id>.<ext>` 提供 |

- 托管链接默认 **1 小时**过期，可在控制台的设置里调整或整体关闭。
- 图片是**按需托管**的 —— 只有当某个目标的模板里出现 `{image}`、或默认载荷需要 `image_url` 时才写入 KV。如果所有目标都只发文字，图片根本不会上传。

## 环境变量与密钥

| 名称 | 类型 | 说明 |
|---|---|---|
| `PUSH_SECRET` | Secret | 推送地址里的口令。未设置时不校验（**不建议**） |
| `ADMIN_TOKEN` | Secret | 控制台与 `/admin/api/*` 的管理口令 |
| `KV` | KV 绑定 | 存目标配置、日志、临时图片。不绑定时可用 `TARGETS` 代替 |
| `TARGETS` | 变量 | 无 KV 时的兜底：直接塞目标数组 JSON（代价是没有控制台和日志） |

## 安全

- 推送地址带 `PUSH_SECRET`，口令不对直接 403，且**不会向任何平台发出请求**。
- 控制台带 `ADMIN_TOKEN`，未授权的管理 API 请求返回 401。
- 截图托管在 `/i/<随机id>`，id 不可枚举，默认 1 小时过期。
- 所有平台密钥只存在你自己的 KV 里，不经过任何第三方。

## 本地开发与测试

```bash
npm test          # 109 项断言：桩掉网络与 KV，验证每个适配器真正发出的请求
npx wrangler dev  # 本地跑，含真实 KV 模拟
```

`test/run.mjs` 覆盖：五种入站载荷解析、15 个适配器的请求体正确性（企业微信 image 的 MD5/base64 与真实 PNG **逐字节比对**）、通用转发的全部占位符与按需图片托管、鉴权、管理操作、日志、边界容错。**不需要任何真实平台密钥**，也不产生外网请求。

## 已知限制

- 单次请求内扇出是并发的，但**没有重试队列**。目标临时故障时该次投递就失败了（结果里会标出）。
- 图片托管依赖 KV，`imageTtl` 最短 60 秒。Kuma/Grafana 这类推送频繁的场景建议用「原生上传」的渠道，或关掉图片托管。
- 免费版 Workers 有每日请求数与 KV 读写额度，个人用途通常远够（10 万请求/天）。
- 无法处理需要发送端配合签名的平台（比如要求回调验签的场景）—— 这是单向扇出，不做双向。

## 免责声明

仅供个人通知用途。请遵守各推送平台的服务条款，不要用于群发垃圾消息。

## License

[MIT](LICENSE)
