/**
 * 本地测试：桩掉 fetch 与 KV，验证 Worker 的各条链路实际发出的请求是否正确。
 * 运行：node test/run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src', 'index.js');
const TMP = path.join(__dirname, '_worker_under_test.mjs');

// 复制一份并额外导出内部函数，便于直接断言
fs.writeFileSync(TMP, fs.readFileSync(SRC, 'utf8') + '\nexport { md5, parseIncoming };\n');
const mod = await import('file://' + TMP.replace(/\\/g, '/'));
const worker = mod.default;

// ---------------- 断言工具 ----------------
let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function section(t) { results.push(`\n[${t}]`); }

// ---------------- 假 KV ----------------
function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      if (type === 'json') return JSON.parse(v);
      if (type === 'arrayBuffer') {
        const b = typeof v === 'string' ? Buffer.from(v) : v;
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
      return v;
    },
    async put(k, v, opts) { m.set(k, v); void opts; },
    async delete(k) { m.delete(k); },
  };
}

// ---------------- 假 fetch：按 URL 返回不同响应并记录请求 ----------------
const seen = [];
function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const rec = { url: u, method: init.method || 'GET', headers: init.headers, body: init.body };
    seen.push(rec);

    const J = (o, status = 200) => new Response(JSON.stringify(o), { status });

    if (u.includes('qyapi.weixin.qq.com/cgi-bin/gettoken')) return J({ errcode: 0, access_token: 'AT_TEST' });
    if (u.includes('qyapi.weixin.qq.com/cgi-bin/media/upload')) return J({ errcode: 0, media_id: 'MEDIA_TEST' });
    if (u.includes('qyapi.weixin.qq.com')) return J({ errcode: 0, errmsg: 'ok' });
    if (u.includes('oapi.dingtalk.com/robot/send')) return J({ errcode: 0 });
    if (u.includes('open.feishu.cn')) return J({ code: 0, StatusCode: 0 });
    if (u.includes('api.telegram.org')) return J({ ok: true, result: { message_id: 1 } });
    if (u.includes('api.day.app')) return J({ code: 200 });
    if (u.includes('sctapi.ftqq.com')) return J({ code: 0 });
    if (u.includes('push.ft07.com')) return J({ code: 0 });
    if (u.includes('pushplus.plus')) return J({ code: 200 });
    if (u.includes('pushdeer.com')) return J({ code: 0 });
    if (u.includes('gotify.example.com')) return J({ id: 1 }, 200);
    if (u.includes('discord.com')) return new Response(null, { status: 200 });
    if (u.includes('ntfy.sh')) return new Response('ok', { status: 200 });
    if (u.includes('wxpusher.zjiecode.com')) return J({ code: 1000 });
    if (u.includes('custom.example.com')) return J({ received: true });
    return J({ ok: true });
  };
}

// ---------------- 假 env ----------------
const SECRET = 'sk_test_123456';
const ADMIN = 'admin_test';
function makeEnv(kv) {
  return { KV: kv, PUSH_SECRET: SECRET, ADMIN_TOKEN: ADMIN };
}

const ORIGIN = 'https://push.example.workers.dev';
const ALL_TARGETS = [
  { id: 'w1', name: '企微群', type: 'wecom_bot', enabled: true, config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' } },
  { id: 'w2', name: '企微应用', type: 'wecom_app', enabled: true, config: { corpid: 'CID', corpsecret: 'SEC', agentid: '1000002', touser: '@all' } },
  { id: 'd1', name: '钉钉', type: 'dingtalk_bot', enabled: true, config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=TOK', secret: 'SECxxx' } },
  { id: 'f1', name: '飞书', type: 'feishu_bot', enabled: true, config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/HOOK', secret: 'FSEC' } },
  { id: 't1', name: 'TG', type: 'telegram', enabled: true, config: { token: '123:ABC', chat_id: '-100123', thread_id: '7' } },
  { id: 'b1', name: 'Bark', type: 'bark', enabled: true, config: { key: 'BKEY', group: '推送通知' } },
  { id: 's1', name: 'Server酱', type: 'serverchan', enabled: true, config: { sendkey: 'SCT123' } },
  { id: 's3', name: 'Server酱3', type: 'serverchan3', enabled: true, config: { url: 'https://123.push.ft07.com/send/SCT3.send' } },
  { id: 'p1', name: 'PushPlus', type: 'pushplus', enabled: true, config: { token: 'PT' } },
  { id: 'p2', name: 'PushDeer', type: 'pushdeer', enabled: true, config: { pushkey: 'PD' } },
  { id: 'g1', name: 'Gotify', type: 'gotify', enabled: true, config: { url: 'https://gotify.example.com', token: 'GT', priority: '7' } },
  { id: 'dc', name: 'Discord', type: 'discord', enabled: true, config: { webhook: 'https://discord.com/api/webhooks/1/2' } },
  { id: 'n1', name: 'ntfy', type: 'ntfy', enabled: true, config: { url: 'https://ntfy.sh', topic: 'mytopic' } },
  { id: 'x1', name: 'WxPusher', type: 'wxpusher', enabled: true, config: { appToken: 'AT_x', uids: 'UID_a, UID_b' } },
  { id: 'c1', name: '通用', type: 'custom', enabled: true, config: { url: 'https://custom.example.com/hook', method: 'POST', headers: '{"Authorization":"Bearer T"}', body: '{"m":"{title}|{content}"}' } },
  { id: 'off', name: '停用的目标', type: 'wecom_bot', enabled: false, config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=NOPE' } },
];

const TITLE = '推送通知|･ω･)';
const CONTENT = '构建已完成 v1.2.3';

// ---------------- 0. MD5 / base64 正确性 ----------------
section('内部函数正确性');
for (const s of ['', 'abc', 'hello world', '推送通知']) {
  const b = new TextEncoder().encode(s);
  const expect = crypto.createHash('md5').update(Buffer.from(b)).digest('hex');
  check(`md5("${s}")`, mod.md5(b) === expect, `got ${mod.md5(b)} want ${expect}`);
}
{
  const buf = crypto.randomBytes(200000);
  check('md5(200KB 随机)', mod.md5(new Uint8Array(buf)) === crypto.createHash('md5').update(buf).digest('hex'));
}

// ---------------- 1. 纯文本 JSON 载荷 ----------------
section('载荷 A：纯文字 JSON（发送端不带截图）');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: ALL_TARGETS, settings: {} }));
  const env = makeEnv(kv);

  const req = new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE, content: CONTENT }),
  });
  const res = await worker.fetch(req, env);
  const j = await res.json();

  check('HTTP 200', res.status === 200, String(res.status));
  check('扇出到 15 个启用目标（停用的不计）', j.summary.total === 15, JSON.stringify(j.summary));
  check('全部成功', j.summary.ok === 15, JSON.stringify(j.results.filter(r => !r.ok)));

  const byHost = (frag) => seen.filter((s) => s.url.includes(frag));
  const wecom = byHost('qyapi').filter((s) => s.url.includes('webhook/send'));
  check('企微机器人收到 markdown', wecom.length >= 1 && String(wecom[0].body).includes('"msgtype":"markdown"'));
  check('企微机器人文本含标题与正文', String(wecom[0].body).includes(CONTENT) && String(wecom[0].body).includes(TITLE));
  check('企微机器人未误发图片消息', !String(wecom[0].body).includes('"msgtype":"image"'));

  const dd = byHost('oapi.dingtalk.com')[0];
  check('钉钉已加签（带 timestamp 与 sign）', dd && dd.url.includes('timestamp=') && dd.url.includes('sign='), dd && dd.url);
  check('钉钉发 markdown', dd && String(dd.body).includes('"msgtype":"markdown"'));

  const fs1 = byHost('open.feishu.cn')[0];
  check('飞书带 timestamp + sign', fs1 && String(fs1.body).includes('"timestamp"') && String(fs1.body).includes('"sign"'));

  // 注意：真实 URL 是 /bot<token>/sendMessage，不能整串匹配
  const tg = byHost('/sendMessage')[0];
  check('TG 带 message_thread_id', tg && String(tg.body).includes('"message_thread_id":7'));

  const bark = byHost('api.day.app/push')[0];
  check('Bark 用 device_key 且无 image 字段', bark && String(bark.body).includes('"device_key":"BKEY"') && !String(bark.body).includes('"image"'));

  const ntfy = byHost('ntfy.sh')[0];
  check('ntfy POST 到 topic 且带 Title 头', ntfy && ntfy.url.endsWith('/mytopic') && ntfy.headers && ntfy.headers.Title);

  const wp = byHost('wxpusher')[0];
  check('WxPusher 拆分多个 uid', wp && String(wp.body).includes('"UID_a"') && String(wp.body).includes('"UID_b"'));

  const cu = byHost('custom.example.com')[0];
  check('通用转发渲染了模板占位符', cu && String(cu.body) === JSON.stringify({ m: TITLE + '|' + CONTENT }), cu && String(cu.body));
  check('通用转发带自定义 Authorization', cu && cu.headers && cu.headers.Authorization === 'Bearer T');

  check('停用的目标未被调用', !seen.some((s) => s.url.includes('key=NOPE')));
}

// ---------------- 2. multipart + 截图 ----------------
section('载荷 B：multipart + 附带截图');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: ALL_TARGETS, settings: {} }));
  const env = makeEnv(kv);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.randomBytes(4096),
  ]);
  const expectMd5 = crypto.createHash('md5').update(png).digest('hex');
  const expectB64 = png.toString('base64');

  const fd = new FormData();
  fd.append('title', TITLE);
  fd.append('content', CONTENT);
  fd.append('image', new Blob([png], { type: 'image/png' }), 'image.png');

  const res = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, { method: 'POST', body: fd }), env);
  const j = await res.json();

  check('HTTP 200 且全部成功', res.status === 200 && j.summary.ok === 15, JSON.stringify(j.results.filter(r => !r.ok)));

  const wecomImg = seen.filter((s) => s.url.includes('qyapi') && String(s.body).includes('"msgtype":"image"'))[0];
  check('企微机器人收到 image 消息', !!wecomImg);
  check('企微 image 的 md5 正确', wecomImg && String(wecomImg.body).includes(expectMd5));
  check('企微 image 的 base64 正确', wecomImg && String(wecomImg.body).includes(expectB64));
  check('企微 image 用的是 input 的 MD5 而非空值', wecomImg && !String(wecomImg.body).includes('"md5":""'));

  const tgPhoto = seen.filter((s) => s.url.includes('/sendPhoto'))[0];
  check('TG 走 sendPhoto 且 body 是 FormData', tgPhoto && (tgPhoto.body instanceof FormData || tgPhoto.body?.constructor?.name === 'FormData'));
  check('TG sendPhoto 带 photo 文件', tgPhoto && String(await tgPhoto.body.get('photo')).length > 0);
  check('TG sendPhoto 带 thread_id', tgPhoto && tgPhoto.body.get('message_thread_id') === '7');

  const dc = seen.filter((s) => s.url.includes('discord.com'))[0];
  check('Discord 用 multipart 且带 payload_json', dc && dc.body instanceof FormData && dc.body.has('payload_json') && dc.body.has('files[0]'));

  const dd = seen.filter((s) => s.url.includes('oapi.dingtalk.com'))[0];
  check('钉钉 markdown 内嵌图片链接', dd && String(dd.body).includes('![](http'), String(dd.body).slice(0, 200));

  const bark = seen.filter((s) => s.url.includes('api.day.app'))[0];
  check('Bark 收到图片 URL', bark && /"image":"http[^"]+\/i\/[^"]+"/.test(String(bark.body)), String(bark.body));

  check('宿主图片已写入 KV', [...kv._m.keys()].some((k) => k.startsWith('img:')));
  check('返回里报告了托管图片数', j.hosted >= 1, String(j.hosted));

  // 图片可被取回
  const imgKey = [...kv._m.keys()].find((k) => k.startsWith('img:'));
  const imgRes = await worker.fetch(new Request(`${ORIGIN}/i/${imgKey.slice(4)}`), env);
  check('托管图片可访问且字节一致', imgRes.status === 200 && (await imgRes.arrayBuffer()).byteLength === png.length);

  const fs1 = seen.filter((s) => s.url.includes('open.feishu.cn'))[0];
  check('飞书只发文字（该平台不支持图片）', fs1 && !String(fs1.body).includes('img'));
}

// ---------------- 3. 自定义 body 模板里的 base64 图片 ----------------
section('载荷 C：自定义 body 模板（JSON 里带 base64 image 字段）');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({
    targets: [{ id: 'w1', name: '企微', type: 'wecom_bot', enabled: true, config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' } }],
    settings: {},
  }));
  const env = makeEnv(kv);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(2048)]);
  const expectMd5 = crypto.createHash('md5').update(png).digest('hex');

  const req = new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE, content: CONTENT, image: png.toString('base64') }),
  });
  const res = await worker.fetch(req, env);
  const j = await res.json();
  check('识别 base64 image 字段并转成图片', j.summary.total === 1 && j.summary.ok === 1);
  const wecomImg = seen.filter((s) => String(s.body).includes('"msgtype":"image"'))[0];
  check('解码后的 md5 与原图一致', wecomImg && String(wecomImg.body).includes(expectMd5));
}

// ---------------- 3.5 通用转发（custom）的图片支持 ----------------
section('通用转发 custom 的图片支持');
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(1024)]);
  const expectB64 = png.toString('base64');

  async function fire(cfg, withImage = true) {
    const kv = fakeKV();
    installFetch(); seen.length = 0;
    await kv.put('config', JSON.stringify({
      targets: [{ id: 'c', name: '通用', type: 'custom', enabled: true, config: cfg }],
      settings: {},
    }));
    const env = makeEnv(kv);
    const fd = new FormData();
    fd.append('title', TITLE);
    fd.append('content', CONTENT);
    if (withImage) fd.append('image', new Blob([png], { type: 'image/png' }), 'shot.png');
    const res = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, { method: 'POST', body: fd }), env);
    const j = await res.json();
    return { kv, j, req: seen[0], hostedKeys: [...kv._m.keys()].filter((k) => k.startsWith('img:')) };
  }

  // a) {image} 占位符 -> 托管地址
  let r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', body: '{"t":"{title}","img":"{image}"}' });
  check('{image} 渲染为托管图片地址', r.req && /"img":"https:\/\/[^"]+\/i\/[^"]+"/.test(String(r.req.body)), String(r.req && r.req.body));
  check('{image} 触发图片落 KV', r.hostedKeys.length === 1, String(r.hostedKeys));
  check('返回的 hosted 计数正确', r.j.hosted === 1, String(r.j.hosted));
  if (r.req) {
    const imgUrl = JSON.parse(String(r.req.body)).img;
    const back = await worker.fetch(new Request(imgUrl), makeEnv(r.kv));
    check('渲染出的图片地址可访问且字节一致',
      back.status === 200 && (await back.arrayBuffer()).byteLength === png.length, String(back.status));
  }

  // b) {image_base64} / {image_name}
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', body: '{"b64":"{image_base64}","name":"{image_name}"}' });
  const bj = JSON.parse(String(r.req.body));
  check('{image_base64} 渲染为原图 base64', bj.b64 === expectB64, `len ${bj.b64 && bj.b64.length}`);
  check('{image_name} 渲染为文件名', bj.name === 'shot.png', String(bj.name));
  check('模板未用 {image} 时不额外托管图片', r.j.hosted === 0, String(r.j.hosted));

  // c) {text} 占位符（用 text 类型，避免把换行塞进 JSON 字符串）
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', body_type: 'text', body: '{text}' }, false);
  check('{text} 渲染为标题+正文', String(r.req.body) === TITLE + '\n' + CONTENT, String(r.req && r.req.body));

  // c2) JSON 模板渲染成非法 JSON 时给出明确报错，而不是把坏载荷发出去
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', body: '{"x":"{text}"}' }, false);
  check('非法 JSON 模板被拦下并给出提示',
    r.j.summary.ok === 0 && r.j.results[0].detail.includes('合法 JSON'), JSON.stringify(r.j.results[0]));
  check('非法 JSON 时未向目标发请求', seen.length === 0, String(seen.length));

  // d) 默认载荷（无 body 模板）+ 图片 -> image_url
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST' });
  const pj = JSON.parse(String(r.req.body));
  check('默认载荷带 title/content', pj.title === TITLE && pj.content === CONTENT, JSON.stringify(pj));
  check('默认载荷附带 image_url', /^https:\/\/[^"]+\/i\/[^"]+$/.test(String(pj.image_url)), String(pj.image_url));
  check('默认载荷的图片已托管', r.j.hosted === 1, String(r.j.hosted));

  // e) with_image=0 关闭
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', with_image: '0' });
  check('with_image=0 时不附带 image_url', !('image_url' in JSON.parse(String(r.req.body))), String(r.req && r.req.body));
  check('with_image=0 时不托管图片', r.j.hosted === 0, String(r.j.hosted));

  // f) 无图片时占位符为空、不报错
  r = await fire({ url: 'https://custom.example.com/hook', method: 'POST', body: '{"img":"{image}"}' }, false);
  check('无图片时 {image} 渲染为空串', JSON.parse(String(r.req.body)).img === '', String(r.req && r.req.body));
  check('无图片时 hosted 为 0', r.j.hosted === 0, String(r.j.hosted));
  check('无图片时仍投递成功', r.j.summary.ok === 1, JSON.stringify(r.j.summary));

  // g) GET + text 类型不应因带 body 而抛异常
  r = await fire({ url: 'https://custom.example.com/hook', method: 'GET', body_type: 'text', body: '{title}' }, false);
  check('GET+text 不发送 body 且不报错', r.j.summary.ok === 1 && r.req && r.req.body === undefined,
    `${JSON.stringify(r.j.summary)} body=${String(r.req && r.req.body)}`);
}

// ---------------- 4. 鉴权 ----------------
section('鉴权');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: ALL_TARGETS, settings: {} }));
  const env = makeEnv(kv);

  const bad = await worker.fetch(new Request(`${ORIGIN}/push/WRONG`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y' }),
  }), env);
  check('错误密钥被拒（403）', bad.status === 403, String(bad.status));
  check('被拒时没有发出任何推送请求', seen.length === 0);

  const noSec = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y' }),
  }), { KV: kv, ADMIN_TOKEN: ADMIN });  // 未配 PUSH_SECRET
  check('未配置密钥时不拦截（兼容）', noSec.status === 200, String(noSec.status));

  const adm = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`), env);
  check('管理 API 无 key 返回 401', adm.status === 401, String(adm.status));
  const adm2 = await worker.fetch(new Request(`${ORIGIN}/admin/api/state?key=${ADMIN}`), env);
  check('管理 API 带 key 可用', adm2.status === 200);
  const st = await adm2.json();
  check('state 返回类型定义与推送地址', Object.keys(st.types).length === 15 && st.pushPath.includes(SECRET), JSON.stringify(Object.keys(st.types).length));
}

// ---------------- 5. 管理操作与日志 ----------------
section('管理操作与日志');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: [], settings: {} }));
  const env = makeEnv(kv);

  await worker.fetch(new Request(`${ORIGIN}/admin/api/targets?key=${ADMIN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: [{ id: 'a', name: 'A', type: 'bark', enabled: true, config: { key: 'BK' } }] }),
  }), env);
  const st = await (await worker.fetch(new Request(`${ORIGIN}/admin/api/state?key=${ADMIN}`), env)).json();
  check('新增目标已持久化', st.targets.length === 1 && st.targets[0].id === 'a');

  const t = await (await worker.fetch(new Request(`${ORIGIN}/admin/api/test?key=${ADMIN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a' }),
  }), env)).json();
  check('单目标测试返回成功', t.ok === true, JSON.stringify(t));

  await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE, content: CONTENT }),
  }), env);
  const st2 = await (await worker.fetch(new Request(`${ORIGIN}/admin/api/state?key=${ADMIN}`), env)).json();
  check('推送后写入日志', st2.logs.length === 1 && st2.logs[0].title === TITLE, JSON.stringify(st2.logs[0]?.title));
  check('日志记录了每个目标的成败', st2.logs[0].results.length === 1 && st2.logs[0].results[0].ok === true);

  const h = await worker.fetch(new Request(`${ORIGIN}/health`), env);
  const hj = await h.json();
  check('/health 正常', h.status === 200 && hj.kv === true && hj.targets === 1, JSON.stringify(hj));
}

// ---------------- 6. 边界与容错 ----------------
section('边界与容错');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: [
    { id: 'bad', name: '坏目标', type: 'wecom_bot', enabled: true, config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' } },
    { id: 'unk', name: '未知类型', type: 'not_exist', enabled: true, config: {} },
  ], settings: {} }));
  const env = makeEnv(kv);

  // 让企微返回错误，检验单个失败不影响整体
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('qyapi')) return new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200 });
    return origFetch(url, init);
  };
  const res = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', content: 'c' }),
  }), env);
  const j = await res.json();
  check('单目标失败时整体仍返回 200 但不 ok', res.status === 200 && j.ok === false);
  check('失败原因被记录', j.results.find(r => r.id === undefined || r.name === '坏目标').detail.includes('93000'), JSON.stringify(j.results));

  const empty = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }), env);
  check('空载荷被拒（400）', empty.status === 400, String(empty.status));

  const plain = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '纯文本内容',
  }), env);
  check('纯文本载荷也能发出去', plain.status === 200, String(plain.status));

  const get = await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}?title=T&content=C`), env);
  check('GET 查询参数也能推送（方便浏览器测）', get.status === 200, String(get.status));

  const r404 = await worker.fetch(new Request(`${ORIGIN}/nope`), env);
  check('未知路径回落到控制台页面', r404.status === 200 && (r404.headers.get('Content-Type') || '').includes('text/html'));
}

// ---------------- 7. 标题兜底（发送端不给 title 的通用场景） ----------------
section('标题兜底与发送端无关性');
{
  const kv = fakeKV();
  installFetch(); seen.length = 0;
  await kv.put('config', JSON.stringify({ targets: [
    { id: 'cu', name: '通用转发', type: 'custom', enabled: true, config: { url: 'https://custom.example.com/hook', method: 'POST', with_image: '0' } },
    { id: 'wb', name: '企微群', type: 'wecom_bot', enabled: true, config: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' } },
  ], settings: {} }));
  const env = makeEnv(kv);

  // 模拟"只发正文"的发送端（很多监控/脚本只推一句话）
  await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '磁盘使用率 95%' }),
  }), env);

  const cu = seen.find((x) => x.url.includes('custom.example.com'));
  const pj = JSON.parse(String(cu.body));
  check('无标题时通用转发的默认载荷有兜底标题', pj.title === '推送通知', String(cu.body));
  check('无标题时正文原样保留', pj.content === '磁盘使用率 95%', String(cu.body));

  const wb = seen.find((x) => x.url.includes('qyapi') && String(x.body).includes('markdown'));
  const md = JSON.parse(String(wb.body)).markdown.content;
  check('群消息正文不会凭空多出一行标题', md === '磁盘使用率 95%', md);

  // 显式标题不能被兜底覆盖
  seen.length = 0;
  await worker.fetch(new Request(`${ORIGIN}/push/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '部署完成', content: 'v1.2.3' }),
  }), env);
  const cu2 = seen.find((x) => x.url.includes('custom.example.com'));
  check('显式标题不被兜底覆盖', JSON.parse(String(cu2.body)).title === '部署完成', String(cu2.body));
}


// ---------------- 8. 适配器覆盖度 ----------------
section('适配器覆盖度');
{
  const names = ['wecom_bot','wecom_app','dingtalk_bot','feishu_bot','telegram','bark','serverchan','serverchan3','pushplus','pushdeer','gotify','discord','ntfy','wxpusher','custom'];
  const kv = fakeKV();
  await kv.put('config', JSON.stringify({ targets: [], settings: {} }));
  const stt = await (await worker.fetch(new Request(`${ORIGIN}/admin/api/state?key=${ADMIN}`), makeEnv(kv))).json();
  for (const n of names) check(`类型 ${n} 已注册`, !!stt.types[n]);
  check('共 15 个适配器', Object.keys(stt.types).length === 15, String(Object.keys(stt.types).length));
  for (const [k, v] of Object.entries(stt.types)) {
    check(`  ${k} 字段定义完整`, Array.isArray(v.fields) && v.fields.length > 0 && v.fields.every(f => f.key && f.label));
  }
}

// ---------------- 汇报 ----------------
console.log(results.join('\n'));
console.log(`\n================ ${pass} passed, ${fail} failed ================`);
fs.unlinkSync(TMP);
process.exit(fail ? 1 : 0);
