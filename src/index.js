/**
 * Push Relay · 一个 Webhook 扇出到多个推送平台 (Cloudflare Worker)
 * ---------------------------------------------------------------
 * 任何能发自定义 Webhook 的服务（监控告警、CI、定时脚本、自动化工具…）
 * 都只需填一个地址，本服务把同一条通知并发扇出到你配置的多个推送渠道。
 *
 * 入站载荷自适应，发送端通常无需任何额外配置：
 *   1) JSON         POST application/json     {"title":..., "content":...}
 *   2) multipart    POST multipart/form-data  字段 title/content + 文件 image
 *   3) 表单         POST application/x-www-form-urlencoded
 *   4) 纯文本       body 直接作为正文
 *   5) GET 查询     ?title=&content=
 * 另支持自定义 body 模板模式（JSON 里的 {image} 为 base64 字符串）。
 *
 * 路由：
 *   POST /push/<PUSH_SECRET>       推送入口（填到发送端）
 *   GET  /admin?key=<ADMIN_TOKEN>  管理界面
 *   GET  /health                   健康检查
 *   GET  /i/<id>                   临时图片托管（供 Bark/钉钉 等需要图片 URL 的平台）
 */

// ============================ 基础工具 ============================

/** 发送端未提供标题时的兜底标题，避免部分平台显示空白 */
const DEFAULT_TITLE = '推送通知';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Key',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const text = (s, status = 200, extra = {}) =>
  new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...extra } });

function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64FromArrayBuffer(buf) {
  return b64(new Uint8Array(buf));
}

async function hmacSha256B64(keyStr, dataStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dataStr));
  return b64FromArrayBuffer(sig);
}

/** 纯 JS MD5（企业微信 image 消息必须带 md5，WebCrypto 不支持 MD5） */
function md5(bytes) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  const len = bytes.length;
  const bitLen = len * 8;
  const total = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    const v = new DataView(padded.buffer, off, 64);
    for (let i = 0; i < 16; i++) w[i] = v.getUint32(i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + w[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function postJson(url, obj, headers = {}, method = 'POST') {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(obj),
  });
  const body = await r.text();
  return { status: r.status, ok: r.ok, body };
}

async function postForm(url, obj, method = 'POST') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.append(k, String(v));
  const r = await fetch(url, { method, body: fd });
  const body = await r.text();
  return { status: r.status, ok: r.ok, body };
}

function clip(s, n = 300) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// Uint8Array -> base64（分块避免 apply 参数过多导致栈溢出）
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ============================ 平台适配器 ============================

/**
 * 每个适配器：
 *   label    界面显示名
 *   fields   配置字段定义（管理界面据此渲染表单）
 *   image    'native' | 'url' | false  —— 图片支持方式
 *   send(cfg, msg, ctx) -> {ok, detail}
 *     msg: {title, content, text, image:{bytes,mime,filename}|null}
 *     ctx: {origin, hostImage(bytes,mime)->url|null}
 */
const ADAPTERS = {
  wecom_bot: {
    label: '企业微信机器人',
    image: 'native',
    fields: [
      { key: 'webhook', label: 'Webhook 地址', required: true, ph: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' },
    ],
    async send(cfg, msg) {
      const r1 = await postJson(cfg.webhook, { msgtype: 'markdown', markdown: { content: msg.text } });
      const j1 = safeJson(r1.body);
      if (j1 && j1.errcode !== 0) return { ok: false, detail: '文本 ' + clip(r1.body) };
      if (msg.image) {
        const r2 = await postJson(cfg.webhook, {
          msgtype: 'image',
          image: { base64: b64(msg.image.bytes), md5: md5(msg.image.bytes) },
        });
        const j2 = safeJson(r2.body);
        if (j2 && j2.errcode !== 0) return { ok: false, detail: '文本OK / 图片 ' + clip(r2.body) };
        return { ok: true, detail: '文本+图片' };
      }
      return { ok: true, detail: '文本' };
    },
  },

  wecom_app: {
    label: '企业微信应用',
    image: 'native',
    fields: [
      { key: 'corpid', label: '企业 ID (corpid)', required: true },
      { key: 'corpsecret', label: '应用密钥 (corpsecret)', required: true },
      { key: 'agentid', label: '应用 AgentId', required: true },
      { key: 'touser', label: '接收人', ph: '@all 或 用户账号，多个用 | 分隔', def: '@all' },
    ],
    async send(cfg, msg) {
      const tk = safeJson((await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpid)}&corpsecret=${encodeURIComponent(cfg.corpsecret)}`
      ).then((r) => r.text())));
      if (!tk || !tk.access_token) return { ok: false, detail: '取 token 失败 ' + clip(JSON.stringify(tk)) };
      const at = tk.access_token;
      const r1 = await postJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${at}`, {
        touser: cfg.touser || '@all', msgtype: 'text', agentid: Number(cfg.agentid), text: { content: msg.text },
      });
      const j1 = safeJson(r1.body);
      if (j1 && j1.errcode !== 0) return { ok: false, detail: clip(r1.body) };
      if (msg.image) {
        const fd = new FormData();
        fd.append('media', new Blob([msg.image.bytes], { type: msg.image.mime }), msg.image.filename);
        const up = safeJson(await (await fetch(
          `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${at}&type=image`,
          { method: 'POST', body: fd }
        )).text());
        if (!up || !up.media_id) return { ok: true, detail: '文本OK / 图片上传失败' };
        const r2 = await postJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${at}`, {
          touser: cfg.touser || '@all', msgtype: 'image', agentid: Number(cfg.agentid), image: { media_id: up.media_id },
        });
        const j2 = safeJson(r2.body);
        if (j2 && j2.errcode !== 0) return { ok: true, detail: '文本OK / 图片 ' + clip(r2.body) };
        return { ok: true, detail: '文本+图片' };
      }
      return { ok: true, detail: '文本' };
    },
  },

  dingtalk_bot: {
    label: '钉钉机器人',
    image: 'url',
    fields: [
      { key: 'webhook', label: 'Webhook 地址', required: true, ph: 'https://oapi.dingtalk.com/robot/send?access_token=xxx' },
      { key: 'secret', label: '加签密钥', ph: '安全设置选「加签」时填，其余留空' },
    ],
    async send(cfg, msg, ctx) {
      let url = cfg.webhook;
      if (cfg.secret) {
        const ts = Date.now();
        const sign = await hmacSha256B64(cfg.secret, `${ts}\n${cfg.secret}`);
        url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
      }
      let md = msg.text;
      if (msg.image) {
        const u = await ctx.hostImage(msg.image.bytes, msg.image.mime);
        if (u) md += `\n\n![](${u})`;
      }
      const r = await postJson(url, { msgtype: 'markdown', markdown: { title: msg.title || DEFAULT_TITLE, text: md } });
      const j = safeJson(r.body);
      if (j && j.errcode !== 0) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: msg.image ? 'markdown(含图片链接)' : 'markdown' };
    },
  },

  feishu_bot: {
    label: '飞书机器人',
    image: false,
    fields: [
      { key: 'webhook', label: 'Webhook 地址', required: true, ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' },
      { key: 'secret', label: '签名校验密钥', ph: '开启「签名校验」时填，否则留空' },
    ],
    async send(cfg, msg) {
      const body = { msg_type: 'text', content: { text: msg.text } };
      if (cfg.secret) {
        const ts = Math.floor(Date.now() / 1000);
        body.timestamp = String(ts);
        body.sign = await hmacSha256B64(`${ts}\n${cfg.secret}`, '');
      }
      const r = await postJson(cfg.webhook, body);
      const j = safeJson(r.body);
      if (j && j.code !== 0 && j.StatusCode !== 0) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  telegram: {
    label: 'Telegram',
    image: 'native',
    fields: [
      { key: 'token', label: 'Bot Token', required: true, ph: '123456:ABC-DEF...' },
      { key: 'chat_id', label: 'Chat / 用户 / 群组 ID', required: true },
      { key: 'thread_id', label: 'Topics 群组 thread_id（可选）' },
    ],
    async send(cfg, msg) {
      const base = `https://api.telegram.org/bot${cfg.token}`;
      const r1 = await postJson(`${base}/sendMessage`, {
        chat_id: cfg.chat_id, text: msg.text, disable_web_page_preview: true,
        ...(cfg.thread_id ? { message_thread_id: Number(cfg.thread_id) } : {}),
      });
      const j1 = safeJson(r1.body);
      if (j1 && j1.ok === false) return { ok: false, detail: clip(r1.body) };
      if (msg.image) {
        const fd = new FormData();
        fd.append('chat_id', String(cfg.chat_id));
        if (cfg.thread_id) fd.append('message_thread_id', String(cfg.thread_id));
        fd.append('photo', new Blob([msg.image.bytes], { type: msg.image.mime }), msg.image.filename);
        const r2 = await fetch(`${base}/sendPhoto`, { method: 'POST', body: fd });
        const j2 = safeJson(await r2.text());
        if (j2 && j2.ok === false) return { ok: true, detail: '文本OK / 图片失败' };
        return { ok: true, detail: '文本+图片' };
      }
      return { ok: true, detail: '文本' };
    },
  },

  bark: {
    label: 'Bark (iOS)',
    image: 'url',
    fields: [
      { key: 'key', label: 'device key', required: true },
      { key: 'base_url', label: '自建服务地址（可选）', ph: '默认 https://api.day.app' },
      { key: 'group', label: '分组名（可选）', def: DEFAULT_TITLE },
      { key: 'sound', label: '铃声（可选）' },
      { key: 'level', label: '中断级别（可选）', ph: 'active / timeSensitive / critical' },
    ],
    async send(cfg, msg, ctx) {
      const base = (cfg.base_url || 'https://api.day.app').replace(/\/+$/, '');
      const body = { device_key: cfg.key, title: msg.title || DEFAULT_TITLE, body: msg.content || '' };
      if (cfg.group) body.group = cfg.group;
      if (cfg.sound) body.sound = cfg.sound;
      if (cfg.level) body.level = cfg.level;
      if (msg.image) {
        const u = await ctx.hostImage(msg.image.bytes, msg.image.mime);
        if (u) body.image = u;
      }
      const r = await postJson(`${base}/push`, body);
      const j = safeJson(r.body);
      if (j && j.code !== 200) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: body.image ? '文本+图片' : '文本' };
    },
  },

  serverchan: {
    label: 'Server酱·Turbo',
    image: false,
    fields: [{ key: 'sendkey', label: 'SendKey', required: true, ph: 'SCT...' }],
    async send(cfg, msg) {
      const r = await postForm(`https://sctapi.ftqq.com/${cfg.sendkey}.send`, {
        title: msg.title || DEFAULT_TITLE, desp: msg.content || '',
      });
      const j = safeJson(r.body);
      if (j && j.code !== 0) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  serverchan3: {
    label: 'Server酱³',
    image: false,
    fields: [
      { key: 'url', label: '发送地址', required: true, ph: 'https://<uid>.push.ft07.com/send/<sendkey>.send' },
    ],
    async send(cfg, msg) {
      const r = await postForm(cfg.url, { title: msg.title || DEFAULT_TITLE, desp: msg.content || '' });
      const j = safeJson(r.body);
      if (j && j.code !== 0) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  pushplus: {
    label: 'PushPlus',
    image: false,
    fields: [
      { key: 'token', label: 'Token', required: true },
      { key: 'topic', label: '群组编码（可选）' },
      { key: 'template', label: '模板', def: 'markdown', ph: 'html / txt / markdown' },
    ],
    async send(cfg, msg) {
      const body = {
        token: cfg.token, title: msg.title || DEFAULT_TITLE,
        content: msg.content || msg.text, template: cfg.template || 'markdown',
      };
      if (cfg.topic) body.topic = cfg.topic;
      const r = await postJson('https://www.pushplus.plus/send', body);
      const j = safeJson(r.body);
      if (j && j.code !== 200) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  pushdeer: {
    label: 'PushDeer',
    image: false,
    fields: [
      { key: 'pushkey', label: 'PushKey', required: true },
      { key: 'url', label: '自建服务地址（可选）', ph: '默认 https://api2.pushdeer.com' },
    ],
    async send(cfg, msg) {
      const base = (cfg.url || 'https://api2.pushdeer.com').replace(/\/+$/, '');
      const r = await postForm(`${base}/message/push`, {
        pushkey: cfg.pushkey, text: msg.title || DEFAULT_TITLE, desp: msg.content || '',
      });
      const j = safeJson(r.body);
      if (j && j.code !== 0) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  gotify: {
    label: 'Gotify',
    image: false,
    fields: [
      { key: 'url', label: '服务地址', required: true, ph: 'https://gotify.example.com' },
      { key: 'token', label: '应用 Token', required: true },
      { key: 'priority', label: '优先级 1-10', def: '5' },
    ],
    async send(cfg, msg) {
      const base = cfg.url.replace(/\/+$/, '');
      const r = await postJson(`${base}/message?token=${encodeURIComponent(cfg.token)}`, {
        title: msg.title || DEFAULT_TITLE, message: msg.content || '',
        priority: Number(cfg.priority || 5),
      });
      if (!r.ok) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  discord: {
    label: 'Discord',
    image: 'native',
    fields: [
      { key: 'webhook', label: 'Webhook URL', required: true, ph: 'https://discord.com/api/webhooks/...' },
      { key: 'username', label: '自定义用户名（可选）' },
    ],
    async send(cfg, msg) {
      if (msg.image) {
        const fd = new FormData();
        fd.append('payload_json', JSON.stringify({
          content: msg.text,
          ...(cfg.username ? { username: cfg.username } : {}),
        }));
        fd.append('files[0]', new Blob([msg.image.bytes], { type: msg.image.mime }), msg.image.filename);
        const r = await fetch(cfg.webhook, { method: 'POST', body: fd });
        if (!r.ok) return { ok: false, detail: clip(await r.text()) };
        return { ok: true, detail: '文本+图片' };
      }
      const r = await postJson(cfg.webhook, {
        content: msg.text, ...(cfg.username ? { username: cfg.username } : {}),
      });
      if (!r.ok) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  ntfy: {
    label: 'ntfy',
    image: 'url',
    fields: [
      { key: 'url', label: '服务地址', required: true, def: 'https://ntfy.sh' },
      { key: 'topic', label: 'Topic', required: true },
      { key: 'token', label: '访问令牌（可选，私有 Topic）' },
    ],
    async send(cfg, msg, ctx) {
      const base = cfg.url.replace(/\/+$/, '');
      const headers = {
        Title: encodeURIComponent(msg.title || DEFAULT_TITLE),
        'Content-Type': 'text/plain; charset=utf-8',
      };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      if (msg.image) {
        const u = await ctx.hostImage(msg.image.bytes, msg.image.mime);
        if (u) headers.Attach = u;
      }
      const r = await fetch(`${base}/${encodeURIComponent(cfg.topic)}`, {
        method: 'POST', headers, body: msg.text,
      });
      if (!r.ok) return { ok: false, detail: clip(await r.text()) };
      return { ok: true, detail: '文本' };
    },
  },

  wxpusher: {
    label: 'WxPusher',
    image: false,
    fields: [
      { key: 'appToken', label: 'appToken', required: true, ph: 'AT_xxx' },
      { key: 'uids', label: 'UID', required: true, ph: 'UID_xxx，多个用英文逗号分隔' },
    ],
    async send(cfg, msg) {
      const uids = cfg.uids.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await postJson('https://wxpusher.zjiecode.com/api/send/message', {
        appToken: cfg.appToken, content: msg.text, summary: msg.title || DEFAULT_TITLE,
        contentType: 1, uids,
      });
      const j = safeJson(r.body);
      if (j && j.code !== 1000) return { ok: false, detail: clip(r.body) };
      return { ok: true, detail: '文本' };
    },
  },

  custom: {
    label: '通用转发（自定义 HTTP）',
    image: 'url',
    fields: [
      { key: 'url', label: '目标地址', required: true },
      { key: 'method', label: '请求方法', def: 'POST', ph: 'GET / POST / PUT' },
      { key: 'headers', label: 'Headers (JSON)', ph: '{"Authorization":"Bearer xxx"}' },
      { key: 'body', label: 'Body 模板', ph: '{"msg":"{title}: {content}","img":"{image}"}  占位符：{title} {content} {text} {image} {image_base64} {image_name}，留空则发 {title,content}' },
      { key: 'body_type', label: 'Body 类型', def: 'json', ph: 'json / text' },
      { key: 'with_image', label: '默认载荷附带图片链接', def: '1', ph: 'Body 模板留空时生效：1 附带 image_url，0 关闭' },
    ],
    async send(cfg, msg, ctx) {
      const method = (cfg.method || 'POST').toUpperCase();
      const img = msg.image || null;
      const rawBody = String(cfg.body || '');

      // 惰性转换：只有模板里真的用到对应占位符时才做（base64 对大图开销显著）
      let imgUrl = '';
      if (img && rawBody.includes('{image}') && ctx) {
        imgUrl = (await ctx.hostImage(img.bytes, img.mime)) || '';
      }
      const imgB64 = (img && rawBody.includes('{image_base64}')) ? bytesToBase64(img.bytes) : '';

      const tpl = (s) => String(s)
        .split('{title}').join(msg.title || '')
        .split('{content}').join(msg.content || '')
        .split('{text}').join(msg.text || '')
        .split('{image_base64}').join(imgB64)
        .split('{image_name}').join((img && img.filename) || '')
        .split('{image}').join(imgUrl);

      let headers = {};
      if (cfg.headers) { try { headers = JSON.parse(tpl(cfg.headers)); } catch { headers = {}; } }

      if (!cfg.body) {
        const payload = { title: msg.title, content: msg.content };
        let extra = '';
        if (img && String(cfg.with_image ?? '1') !== '0' && ctx) {
          const u = await ctx.hostImage(img.bytes, img.mime);
          if (u) { payload.image_url = u; extra = ' · 含图片链接'; }
        }
        if ((cfg.body_type || 'json') === 'text') {
          let textBody = tpl('{title}\n{content}');
          if (payload.image_url) textBody += '\n' + payload.image_url;
          // GET 不能带 body，否则 Workers 的 fetch 会直接抛异常
          const r = await fetch(cfg.url, {
            method,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
            body: method === 'GET' ? undefined : textBody,
          });
          if (!r.ok) return { ok: false, detail: clip(await r.text()) };
          return { ok: true, detail: 'text' + extra };
        }
        const r = await postJson(cfg.url, payload, headers, method);
        if (!r.ok) return { ok: false, detail: clip(r.body) };
        return { ok: true, detail: 'json · ' + clip(r.body, 160) + extra };
      }

      const rendered = tpl(rawBody);
      const isJson = (cfg.body_type || 'json') === 'json';
      // 预校验：标题/正文里的引号或换行会把 JSON 模板渲染坏。与其把非法载荷
      // 发给目标再收到一个含糊的 400，不如在这里给出可执行的提示。
      if (isJson && rendered.trim() && safeJson(rendered) === null) {
        return {
          ok: false,
          detail: 'Body 模板渲染后不是合法 JSON（{title}/{content} 里可能含引号或换行）；'
            + '可改用 body_type=text，或去掉模板里的 {text}',
        };
      }
      const r = await fetch(cfg.url, {
        method,
        headers: isJson ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: method === 'GET' ? undefined : rendered,
      });
      if (!r.ok) return { ok: false, detail: clip(await r.text()) };
      return { ok: true, detail: 'custom · ' + clip(await r.text(), 160) };
    },
  },
};

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ============================ 配置与日志 ============================

const KEY_CONFIG = 'config';
const KEY_LOGS = 'logs';

const DEFAULT_SETTINGS = { hostImage: true, imageTtl: 3600, maxLogs: 50 };

async function loadConfig(env) {
  let cfg = null;
  if (env.KV) {
    cfg = await env.KV.get(KEY_CONFIG, 'json');
  }
  if (!cfg && env.TARGETS) {
    try { cfg = { targets: JSON.parse(env.TARGETS), settings: {} }; } catch { /* ignore */ }
  }
  cfg = cfg || { targets: [], settings: {} };
  cfg.targets = Array.isArray(cfg.targets) ? cfg.targets : [];
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  return cfg;
}

async function saveConfig(env, cfg) {
  if (!env.KV) throw new Error('未绑定 KV 命名空间，无法保存配置（请改用 TARGETS 环境变量）');
  await env.KV.put(KEY_CONFIG, JSON.stringify(cfg));
}

async function appendLog(env, record) {
  if (!env.KV) return;
  const cfg = await loadConfig(env);
  const logs = (await env.KV.get(KEY_LOGS, 'json')) || [];
  logs.unshift(record);
  await env.KV.put(KEY_LOGS, JSON.stringify(logs.slice(0, cfg.settings.maxLogs || 50)));
}

// ============================ 载荷解析 ============================

/**
 * 把入站请求归一化成 {title, content, text, image}
 * 兼容：JSON / multipart / urlencoded / GET query
 */
async function parseIncoming(request) {
  const url = new URL(request.url);
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  let title = '', content = '', image = null;

  const fromBase64 = (s, mime) => {
    try {
      const bin = atob(String(s).replace(/^data:[^,]+,/, '').replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (!bytes.length) return null;
      const m = /^data:(image\/[a-z0-9.+-]+)/i.exec(String(s)) || [];
      return { bytes, mime: mime || m[1] || 'image/png', filename: 'image.png' };
    } catch { return null; }
  };

  const normContent = (v) => Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : (v == null ? '' : String(v));

  if (request.method === 'GET') {
    title = url.searchParams.get('title') || url.searchParams.get('text') || '';
    content = url.searchParams.get('content') || url.searchParams.get('desp') || '';
  } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const fd = await request.formData();
    title = normContent(fd.get('title'));
    content = normContent(fd.get('content'));
    const f = fd.get('image') || fd.get('img') || fd.get('file');
    if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function') {
      const buf = await f.arrayBuffer();
      if (buf.byteLength) {
        image = {
          bytes: new Uint8Array(buf),
          mime: f.type || 'image/png',
          filename: f.name || 'image.png',
        };
      }
    }
    if (!title && !content) {
      const alt = fd.get('message') || fd.get('text') || fd.get('msg');
      if (alt) content = normContent(alt);
    }
  } else {
    const raw = await request.text();
    let data = safeJson(raw);
    if (data === null) {
      // 不是 JSON，当纯文本处理
      title = '';
      content = raw;
    } else {
      if (typeof data === 'string' || Array.isArray(data)) {
        content = normContent(data);
      } else {
        title = normContent(data.title ?? data.Title ?? data.subject ?? data.msg_title ?? '');
        content = normContent(data.content ?? data.Content ?? data.desp ?? data.message ?? data.body ?? data.msg ?? '');
        if (!title && !content && data.text != null) content = normContent(data.text);
        if (!title && !content) {
          // 未识别出任何已知字段时，只有原始载荷里确实含字面内容才回落到原文。
          // 否则空对象 {} 或纯结构字符会被当成一条消息推出去。
          const stripped = String(raw).replace(/[{}\[\]",:\s]/g, '');
          if (stripped.length > 0) content = String(raw).trim();
        }
        const imgField = data.image ?? data.Image ?? data.img ?? data.image_base64;
        if (typeof imgField === 'string' && imgField.length > 32) {
          image = fromBase64(imgField, data.image_mime);
        }
      }
    }
    if (!title && !content) {
      const q = url.searchParams;
      title = q.get('title') || '';
      content = q.get('content') || '';
    }
  }

  const text = [title, content].filter((s) => s && s.trim()).join('\n');
  return { title, content, text, image };
}

// ============================ 扇出 ============================

async function fanOut(env, msg, origin) {
  const cfg = await loadConfig(env);
  const targets = cfg.targets.filter((t) => t.enabled !== false);
  const hosted = [];

  // 发送端未提供标题时统一兜底。放在扇出入口而不是逐个适配器里，是为了让
  // 「通用转发」的默认载荷也能带上标题（它不做 title 兜底，会原样发出空串）。
  // 刻意不重算 msg.text —— 正文保持发送端原样，不会凭空多出一行标题。
  if (!msg.title) msg.title = DEFAULT_TITLE;

  const ctx = {
    origin,
    async hostImage(bytes, mime) {
      if (!cfg.settings.hostImage || !env.KV) return null;
      try {
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
        const key = `img:${id}.${ext}`;
        await env.KV.put(key, bytes, { expirationTtl: Math.max(60, cfg.settings.imageTtl || 3600) });
        hosted.push(key);
        return `${origin}/i/${id}.${ext}`;
      } catch { return null; }
    },
  };

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      const ad = ADAPTERS[t.type];
      if (!ad) return { name: t.name, type: t.type, ok: false, detail: '未知类型 ' + t.type };
      try {
        const r = await ad.send(t.config || {}, msg, ctx);
        return { name: t.name || ad.label, type: t.type, ok: !!r.ok, detail: r.detail || '' };
      } catch (e) {
        return { name: t.name || ad.label, type: t.type, ok: false, detail: '异常 ' + String(e && e.message || e) };
      }
    })
  );

  const out = results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, detail: 'rejected ' + String(r.reason) }));
  const okCount = out.filter((r) => r.ok).length;

  return {
    out,
    summary: { total: out.length, ok: okCount, failed: out.length - okCount },
    hosted,
  };
}

// ============================ 路由 ============================

function checkSecret(env, request, url, pathPrefix) {
  const secret = env.PUSH_SECRET;
  if (!secret) return true; // 未设置则不校验（不建议）
  const fromPath = pathPrefix ? url.pathname.slice(pathPrefix.length).replace(/^\/+|\/+$/g, '') : '';
  const fromQuery = url.searchParams.get('token') || url.searchParams.get('key') || '';
  const fromHeader = request.headers.get('X-Push-Secret') || '';
  const fromAuth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return [fromPath, fromQuery, fromHeader, fromAuth].some((v) => v && v === secret);
}

function checkAdmin(env, request, url) {
  const t = env.ADMIN_TOKEN;
  if (!t) return false;
  const k = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
  return k === t;
}

function routePushPath(pathname) {
  for (const p of ['/push/', '/notify/', '/webhook/']) {
    if (pathname.startsWith(p)) return p;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 健康检查
    if (url.pathname === '/health') {
      const cfg = await loadConfig(env);
      return json({
        ok: true,
        kv: !!env.KV,
        targets: cfg.targets.length,
        enabled: cfg.targets.filter((t) => t.enabled !== false).length,
        secretRequired: !!env.PUSH_SECRET,
      });
    }

    // 临时图片托管
    if (url.pathname.startsWith('/i/')) {
      if (!env.KV) return text('no kv', 500);
      const key = 'img:' + url.pathname.slice(3);
      const buf = await env.KV.get(key, 'arrayBuffer');
      if (!buf) return text('image expired or not found', 404);
      return new Response(buf, {
        headers: { 'Content-Type': 'image/' + (key.split('.').pop() === 'jpg' ? 'jpeg' : key.split('.').pop()), 'Cache-Control': 'public, max-age=300', ...CORS },
      });
    }

    // 管理 API
    if (url.pathname.startsWith('/admin/api/')) {
      if (!checkAdmin(env, request, url)) return json({ error: 'unauthorized' }, 401);
      const cfg = await loadConfig(env);

      if (url.pathname === '/admin/api/state') {
        const logs = env.KV ? ((await env.KV.get(KEY_LOGS, 'json')) || []) : [];
        const types = Object.fromEntries(
          Object.entries(ADAPTERS).map(([k, v]) => [k, { label: v.label, fields: v.fields, image: v.image }])
        );
        return json({ targets: cfg.targets, settings: cfg.settings, types, logs, pushPath: `/push/${env.PUSH_SECRET || '<未设置密钥>'}` });
      }
      if (url.pathname === '/admin/api/targets' && request.method === 'POST') {
        const body = await request.json();
        const list = Array.isArray(body.targets) ? body.targets : cfg.targets;
        cfg.targets = list;
        await saveConfig(env, cfg);
        return json({ ok: true, targets: cfg.targets });
      }
      if (url.pathname === '/admin/api/settings' && request.method === 'POST') {
        const body = await request.json();
        cfg.settings = { ...cfg.settings, ...body };
        await saveConfig(env, cfg);
        return json({ ok: true, settings: cfg.settings });
      }
      if (url.pathname === '/admin/api/test' && request.method === 'POST') {
        const body = await request.json();
        const t = (cfg.targets || []).find((x) => x.id === body.id);
        if (!t) return json({ error: 'target not found' }, 404);
        const ad = ADAPTERS[t.type];
        if (!ad) return json({ error: 'unknown type' }, 400);
        const msg = { title: DEFAULT_TITLE, content: '这是一条测试消息', text: DEFAULT_TITLE + '\n这是一条测试消息', image: null };
        const ctx = { origin, hostImage: async () => null };
        try {
          const r = await ad.send(t.config || {}, msg, ctx);
          return json({ ok: !!r.ok, detail: r.detail || '' });
        } catch (e) {
          return json({ ok: false, detail: String(e && e.message || e) });
        }
      }
      if (url.pathname === '/admin/api/logs' && request.method === 'DELETE') {
        if (env.KV) await env.KV.delete(KEY_LOGS);
        return json({ ok: true });
      }
      if (url.pathname === '/admin/api/cleartargets' && request.method === 'POST') {
        cfg.targets = [];
        await saveConfig(env, cfg);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    }

    // 管理界面
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 推送入口：/push/<secret>
    const prefix = routePushPath(url.pathname);
    if (prefix) {
      if (!checkSecret(env, request, url, prefix)) {
        return json({ ok: false, error: 'forbidden: bad or missing secret' }, 403);
      }
      let msg;
      try {
        msg = await parseIncoming(request);
      } catch (e) {
        return json({ ok: false, error: 'bad payload: ' + String(e && e.message || e) }, 400);
      }
      if (!msg.text && !msg.image) return json({ ok: false, error: 'empty message' }, 400);

      const { out, summary, hosted } = await fanOut(env, msg, origin);
      await appendLog(env, {
        at: new Date().toISOString(),
        title: clip(msg.title, 80),
        content: clip(msg.content, 200),
        hasImage: !!msg.image,
        imageBytes: msg.image ? msg.image.bytes.length : 0,
        summary,
        results: out,
      });
      return json({ ok: summary.failed === 0, summary, results: out, hosted: hosted.length });
    }

    // 根路径给个说明
    return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};

// ============================ 管理界面 ============================

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Push Relay · 控制台</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1f2328;--dim:#6b7280;--pri:#2563eb;--ok:#16a34a;--err:#dc2626;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  main{max-width:1080px;margin:0 auto;padding:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 12px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
  input,select,textarea,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--fg)}
  input,select,textarea{width:100%}
  textarea{min-height:60px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
  button{cursor:pointer;background:var(--pri);color:#fff;border-color:var(--pri);white-space:nowrap}
  button.ghost{background:#fff;color:var(--fg);border-color:var(--line)}
  button.danger{background:#fff;color:var(--err);border-color:#f2c4c4}
  button:disabled{opacity:.5;cursor:not-allowed}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .grid{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;align-items:center}
  .grid label{color:var(--dim);font-size:13px}
  .t{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}
  .t:last-child{border-bottom:0}
  .t .meta{font-size:12px;color:var(--dim);word-break:break-all}
  .pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);margin-left:6px}
  .ok{color:var(--ok)}.err{color:var(--err)}
  .hint{font-size:12px;color:var(--dim);margin-top:6px}
  code{background:#f0f2f5;padding:1px 5px;border-radius:4px;font-size:12px}
  dialog{border:1px solid var(--line);border-radius:12px;padding:0;max-width:620px;width:92%}
  dialog::backdrop{background:rgba(0,0,0,.35)}
  .dlg-h{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:600}
  .dlg-b{padding:18px;max-height:60vh;overflow:auto}
  .dlg-f{padding:14px 18px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}
  pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:260px}
  .log{border-bottom:1px solid var(--line);padding:10px 0;font-size:13px}
  .log:last-child{border-bottom:0}
</style></head><body>
<header>
  <h1>Push Relay · 控制台</h1>
  <input id="key" placeholder="ADMIN_TOKEN" style="width:220px">
  <button onclick="boot()">载入</button>
  <span id="status" class="hint"></span>
</header>
<main>
  <div class="card">
    <h2>Webhook 接收地址</h2>
    <div class="row"><code id="pushurl">载入后显示</code>
      <button class="ghost" onclick="copyUrl()">复制</button></div>
    <div class="hint">把上面的地址填到任何支持自定义 Webhook 的服务里即可 —— 三月七小助手（设置 → 消息推送 → Webhook）、Uptime Kuma、Grafana、青龙面板、CI 通知、你自己的脚本都行。本服务自适应 JSON / multipart / 表单 / 纯文本 / GET 参数，发送端一般不用改任何东西。</div>
  </div>

  <div class="card">
    <h2>推送目标 <span id="cnt" class="pill"></span></h2>
    <div id="targets"></div>
    <div class="row" style="margin-top:14px">
      <button onclick="openAdd()">+ 添加目标</button>
      <button class="ghost" onclick="testAll()">全部测试</button>
    </div>
  </div>

  <div class="card">
    <h2>最近推送记录</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="ghost" onclick="loadLogs()">刷新</button>
      <button class="danger" onclick="clearLogs()">清空</button>
    </div>
    <div id="logs"></div>
  </div>
</main>

<dialog id="dlg">
  <div class="dlg-h" id="dlgTitle">添加目标</div>
  <div class="dlg-b">
    <div class="grid">
      <label>名称</label><input id="f_name" placeholder="例如：我的企微群">
      <label>类型</label><select id="f_type" onchange="renderFields()"></select>
      <label>启用</label><select id="f_enabled"><option value="1">启用</option><option value="0">停用</option></select>
    </div>
    <div id="f_fields" style="margin-top:12px"></div>
  </div>
  <div class="dlg-f">
    <button class="ghost" onclick="dlg.close()">取消</button>
    <button onclick="saveTarget()">保存</button>
  </div>
</dialog>

<script>
var KEY='', STATE=null, EDIT=null;
function h(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function auth(q){KEY=document.getElementById('key').value.trim();localStorage.setItem('push_relay_key',KEY);
  return '/admin/api/'+q+(q.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY)}
function setMsg(s,cls){var e=document.getElementById('status');e.textContent=s||'';e.className='hint '+(cls||'')}

document.getElementById('key').value=localStorage.getItem('push_relay_key')||'';

async function boot(){
  setMsg('载入中...');
  try{
    var r=await fetch(auth('state')); if(!r.ok) throw new Error('HTTP '+r.status);
    STATE=await r.json();
    document.getElementById('pushurl').textContent=location.origin+STATE.pushPath;
    var sel=document.getElementById('f_type');
    sel.innerHTML=Object.keys(STATE.types).map(function(k){return '<option value="'+k+'">'+h(STATE.types[k].label)+'</option>'}).join('');
    renderTargets(); renderLogs(STATE.logs);
    setMsg('已载入 · '+STATE.targets.length+' 个目标','ok');
  }catch(e){ setMsg('载入失败：'+e.message+'（检查 ADMIN_TOKEN 是否正确）','err') }
}

function renderTargets(){
  var box=document.getElementById('targets');
  var ts=STATE.targets||[];
  document.getElementById('cnt').textContent=ts.length+' 个';
  if(!ts.length){box.innerHTML='<div class="hint">还没有目标。点下面的「添加目标」开始配置。</div>';return}
  box.innerHTML=ts.map(function(t){
    var lab=(STATE.types[t.type]||{}).label||t.type;
    var keys=Object.keys(t.config||{}).filter(function(k){return t.config[k]}).map(function(k){return k+'='+h(t.config[k]).slice(0,64)}).join(' · ');
    return '<div class="t"><div style="flex:1"><b>'+h(t.name||lab)+'</b>'
      +'<span class="pill">'+h(lab)+'</span>'
      +'<span class="pill '+(t.enabled===false?'err':'ok')+'">'+(t.enabled===false?'停用':'启用')+'</span>'
      +'<div class="meta">'+keys+'</div>'
      +'<div class="meta" id="tr_'+t.id+'"></div></div>'
      +'<div class="row"><button class="ghost" onclick="testOne(\\''+t.id+'\\')">测试</button>'
      +'<button class="ghost" onclick="toggle(\\''+t.id+'\\')">'+(t.enabled===false?'启用':'停用')+'</button>'
      +'<button class="ghost" onclick="openEdit(\\''+t.id+'\\')">编辑</button>'
      +'<button class="danger" onclick="del(\\''+t.id+'\\')">删除</button></div></div>';
  }).join('');
}

function renderFields(prefill){
  var type=document.getElementById('f_type').value;
  var def=STATE.types[type]; if(!def) return;
  document.getElementById('f_fields').innerHTML='<div class="grid">'+def.fields.map(function(f){
    var v=prefill&&prefill[f.key]!=null?prefill[f.key]:(f.def||'');
    var long=f.key==='headers'||f.key==='body'||f.key==='webhook'||f.key==='url';
    var inp=long?'<textarea id="c_'+f.key+'" '+(f.required?'required':'')+' placeholder="'+h(f.ph||'')+'">'+h(v)+'</textarea>'
                :'<input id="c_'+f.key+'" '+(f.required?'required':'')+' value="'+h(v)+'" placeholder="'+h(f.ph||'')+'">';
    return '<label>'+h(f.label)+(f.required?' *':'')+'</label>'+inp;
  }).join('')+'</div>'+(def.image?'<div class="hint">该平台支持图片：'+({native:'直接上传',url:'转图片链接后附带'}[def.image]||'')+'</div>':'<div class="hint">该平台不支持图片，只发文字。</div>');
}

function openAdd(){
  EDIT=null; document.getElementById('dlgTitle').textContent='添加目标';
  document.getElementById('f_name').value=''; document.getElementById('f_enabled').value='1';
  renderFields(null); dlg.showModal();
}
function openEdit(id){
  var t=STATE.targets.find(function(x){return x.id===id}); if(!t) return;
  EDIT=t; document.getElementById('dlgTitle').textContent='编辑目标';
  document.getElementById('f_name').value=t.name||'';
  document.getElementById('f_type').value=t.type;
  document.getElementById('f_enabled').value=t.enabled===false?'0':'1';
  renderFields(t.config||{}); dlg.showModal();
}
function collect(){
  var type=document.getElementById('f_type').value, cfg={};
  STATE.types[type].fields.forEach(function(f){
    var el=document.getElementById('c_'+f.key); if(el) cfg[f.key]=el.value.trim();
  });
  return {name:document.getElementById('f_name').value.trim(),type:type,
          enabled:document.getElementById('f_enabled').value==='1',config:cfg};
}
async function saveTarget(){
  var t=collect(); if(!t.name) t.name=STATE.types[t.type].label;
  if(EDIT){ t.id=EDIT.id; var i=STATE.targets.indexOf(EDIT); STATE.targets[i]=t }
  else { t.id=Math.random().toString(36).slice(2,10); STATE.targets.push(t) }
  await pushTargets(); dlg.close(); renderTargets(); setMsg('已保存','ok');
}
async function pushTargets(){
  var r=await fetch(auth('targets'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targets:STATE.targets})});
  if(!r.ok) setMsg('保存失败 HTTP '+r.status,'err');
}
async function del(id){ if(!confirm('确认删除这个目标？')) return;
  STATE.targets=STATE.targets.filter(function(x){return x.id!==id}); await pushTargets(); renderTargets(); setMsg('已删除','ok') }
async function toggle(id){ var t=STATE.targets.find(function(x){return x.id===id});
  t.enabled=(t.enabled===false); await pushTargets(); renderTargets() }
async function testOne(id){
  var el=document.getElementById('tr_'+id); if(el) el.innerHTML='测试中...';
  var r=await fetch(auth('test'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
  var j=await r.json().catch(function(){return{}});
  if(el) el.innerHTML='<span class="'+(j.ok?'ok':'err')+'">'+(j.ok?'投递成功':'失败')+'</span> '+(j.detail?'· '+h(j.detail):'');
}
async function testAll(){ for(var i=0;i<STATE.targets.length;i++){ await testOne(STATE.targets[i].id) } }
function renderLogs(logs){
  var box=document.getElementById('logs');
  if(!logs||!logs.length){box.innerHTML='<div class="hint">暂无记录</div>';return}
  box.innerHTML=logs.map(function(l){
    var s=l.summary||{};
    var detail=(l.results||[]).map(function(r){return '<span class="'+(r.ok?'ok':'err')+'">'+h(r.name)+'</span>'}).join(' ');
    return '<div class="log"><b>'+h(l.title||'(无标题)')+'</b> <span class="pill">'+h(new Date(l.at).toLocaleString('zh-CN'))+'</span>'
      +(l.hasImage?'<span class="pill">含图 '+Math.round((l.imageBytes||0)/1024)+'KB</span>':'')
      +'<div class="meta">成功 '+(s.ok||0)+'/'+(s.total||0)+' · '+detail+'</div>'
      +'<div class="meta">'+h(l.content||'')+'</div></div>';
  }).join('');
}
async function loadLogs(){ var r=await fetch(auth('state')); var j=await r.json(); renderLogs(j.logs) }
async function clearLogs(){ if(!confirm('清空推送记录？')) return;
  await fetch(auth('logs'),{method:'DELETE'}); loadLogs() }
function copyUrl(){ navigator.clipboard.writeText(document.getElementById('pushurl').textContent); setMsg('已复制','ok') }
</script></body></html>`;
