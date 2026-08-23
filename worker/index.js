// Yiko API — Cloudflare Worker, 零依赖单模块
// bindings: DB (D1) / KV / AUDIO (R2)
// secrets:  JWT_SECRET (必须) / UPSTREAM_API_KEY / UPSTREAM_BASE / UPSTREAM_MODEL / TTS_API_KEY / TTS_BASE / TTS_MODEL / DEV_LOGIN_CODE

const VERSION = "0.1.0";
const FREE_DAILY_GEN = 50;

const GEN_SYSTEM = `你是一位帮中国职场人练口语的教练。用户给你一句想说的中文（可能是碎片、可能中英混杂），你给出母语者在同样场景下真实会说的口语版本。目标语言由 target 指定：en=英语，yue=粤语（口语粤文，附粤拼）。
规则：1.按场景重述不逐字翻译，目标是口语。2.why 一行说人话不讲语法术语。3.常见中式直译陷阱写进 trap，没有填 null。4.不出现「错误/Wrong/Incorrect」。5.输出保持一到两句自然口语。
只输出 JSON：{"english":"...","why":"...","trap":"..."或 null}（粤语时 english 字段放粤文，另加 "jyutping":"..."）`;

// ---------- utils ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers } });
const err = (status, message) => json({ error: message }, status);
const now = () => Date.now();
const day = () => new Date().toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function signJwt(env, payload) {
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson({ ...payload, iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 60 * 60 * 24 * 90 });
  return `${head}.${body}.${await hmac(env.JWT_SECRET, `${head}.${body}`)}`;
}

async function verifyJwt(env, token) {
  const [h, b, s] = (token || "").split(".");
  if (!h || !b || !s) return null;
  if ((await hmac(env.JWT_SECRET, `${h}.${b}`)) !== s) return null;
  try {
    const payload = JSON.parse(atob(b.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp < now() / 1000) return null;
    return payload;
  } catch { return null; }
}

async function auth(env, request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const payload = await verifyJwt(env, token);
  return payload && payload.sub ? payload.sub : null;
}

// ---------- handlers ----------
async function health(env) {
  let d1 = false, kv = false;
  try { await env.DB.prepare("SELECT 1").first(); d1 = true; } catch {}
  try { await env.KV.put("health", String(now()), { expirationTtl: 60 }); kv = true; } catch {}
  return json({ ok: d1 && kv, version: VERSION, d1, kv, ts: now() });
}

/** OTP 登录。短信商未接入前：设置了 DEV_LOGIN_CODE 时可用该码直接登录（仅内测）。 */
async function otpRequest(env, body) {
  if (!body.phone) return err(400, "phone required");
  if (!env.SMS_PROVIDER) return err(501, "SMS provider not configured yet");
  return err(501, "not implemented");
}

async function otpVerify(env, body) {
  const { phone, code } = body;
  if (!phone || !code) return err(400, "phone and code required");
  const devOk = env.DEV_LOGIN_CODE && code === env.DEV_LOGIN_CODE;
  const kvCode = await env.KV.get(`otp:${phone}`);
  if (!devOk && (!kvCode || kvCode !== code)) return err(401, "invalid code");
  let user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  if (!user) {
    user = { id: uuid(), phone, plan: "free", created_at: now() };
    await env.DB.prepare("INSERT INTO users (id, phone, plan, created_at) VALUES (?,?,?,?)")
      .bind(user.id, phone, user.plan, user.created_at).run();
  }
  return json({ token: await signJwt(env, { sub: user.id }), user: { id: user.id, plan: user.plan } });
}

async function me(env, userId) {
  const user = await env.DB.prepare("SELECT id, phone, plan, plan_expires_at, created_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return err(404, "user not found");
  const usage = await env.DB.prepare("SELECT gen_count, tts_chars FROM usage_daily WHERE user_id = ? AND day = ?").bind(userId, day()).first();
  return json({ user, today: usage || { gen_count: 0, tts_chars: 0 }, quota: { daily_gen: FREE_DAILY_GEN } });
}

async function bumpUsage(env, userId, field, amount) {
  await env.DB.prepare(
    `INSERT INTO usage_daily (user_id, day, ${field}) VALUES (?,?,?)
     ON CONFLICT(user_id, day) DO UPDATE SET ${field} = ${field} + ?`
  ).bind(userId, day(), amount, amount).run();
}

/** 地道化生成代理。托管额度：免费档每日 FREE_DAILY_GEN 次。 */
async function generate(env, userId, body) {
  const { zh, target = "en" } = body;
  if (!zh) return err(400, "zh required");
  if (!env.UPSTREAM_API_KEY) return err(503, "upstream not configured — 内测期请在 app 内使用 BYOK 模式");
  const usage = await env.DB.prepare("SELECT gen_count FROM usage_daily WHERE user_id = ? AND day = ?").bind(userId, day()).first();
  if ((usage?.gen_count || 0) >= FREE_DAILY_GEN) return err(429, "今日免费生成次数已用完");
  const base = (env.UPSTREAM_BASE || "https://api.x.ai/v1").replace(/\/$/, "");
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "authorization": `Bearer ${env.UPSTREAM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.UPSTREAM_MODEL || "grok-4",
      temperature: 0.4,
      messages: [
        { role: "system", content: GEN_SYSTEM },
        { role: "user", content: `target: ${target}\n${zh}` },
      ],
    }),
  });
  if (!resp.ok) return err(502, `upstream ${resp.status}`);
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  const s = content.indexOf("{"), e = content.lastIndexOf("}");
  let out = {};
  try { out = JSON.parse(content.slice(s, e + 1)); } catch { out = { english: content.trim(), why: "", trap: null }; }
  await bumpUsage(env, userId, "gen_count", 1);
  return json(out);
}

/** TTS 代理（骨架）：按语言路由，未配置返回 503。 */
async function tts(env, userId, body) {
  const { text, lang = "en" } = body;
  if (!text) return err(400, "text required");
  if (!env.TTS_API_KEY) return err(503, "tts upstream not configured — 内测期请在 app 内使用 BYOK 模式");
  const base = (env.TTS_BASE || "https://api.openai.com/v1").replace(/\/$/, "");
  const resp = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "authorization": `Bearer ${env.TTS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.TTS_MODEL || "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "mp3" }),
  });
  if (!resp.ok) return err(502, `tts upstream ${resp.status}`);
  await bumpUsage(env, userId, "tts_chars", text.length);
  return new Response(resp.body, { headers: { "content-type": "audio/mpeg", "access-control-allow-origin": "*" } });
}

/** 增量同步：GET ?since=ms 拉取；PUT {items:[...]} 推送（LWW by updated_at）。 */
async function syncGet(env, userId, table, since) {
  const rows = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE user_id = ? AND updated_at > ? ORDER BY updated_at LIMIT 500`
  ).bind(userId, since).all();
  return json({ items: rows.results, server_ts: now() });
}

async function syncPutSentences(env, userId, items) {
  for (const it of items.slice(0, 200)) {
    await env.DB.prepare(
      `INSERT INTO sentences (id, user_id, zh, en, why, trap, target_lang, shadow_count, deleted, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET zh=excluded.zh, en=excluded.en, why=excluded.why, trap=excluded.trap,
         target_lang=excluded.target_lang, shadow_count=excluded.shadow_count, deleted=excluded.deleted, updated_at=excluded.updated_at
       WHERE excluded.updated_at > sentences.updated_at AND sentences.user_id = excluded.user_id`
    ).bind(it.id, userId, it.zh, it.en, it.why || "", it.trap || null, it.target_lang || "en",
      it.shadow_count || 0, it.deleted ? 1 : 0, it.created_at || now(), it.updated_at || now()).run();
  }
  return json({ ok: true, server_ts: now() });
}

async function syncPutWords(env, userId, items) {
  for (const it of items.slice(0, 200)) {
    await env.DB.prepare(
      `INSERT INTO words (id, user_id, sentence_id, word, ipa, deleted, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET word=excluded.word, ipa=excluded.ipa, deleted=excluded.deleted, updated_at=excluded.updated_at
       WHERE excluded.updated_at > words.updated_at AND words.user_id = excluded.user_id`
    ).bind(it.id, userId, it.sentence_id, it.word, it.ipa || "", it.deleted ? 1 : 0,
      it.created_at || now(), it.updated_at || now()).run();
  }
  return json({ ok: true, server_ts: now() });
}

async function trackEvent(env, userId, body) {
  if (!body.type) return err(400, "type required");
  await env.DB.prepare("INSERT INTO events (user_id, type, payload, created_at) VALUES (?,?,?,?)")
    .bind(userId, body.type, JSON.stringify(body.payload || {}), now()).run();
  return json({ ok: true });
}

/** 发布物直链：R2 releases/ 前缀。上传需 ADMIN_TOKEN，下载公开。 */
async function releaseUpload(env, request, name) {
  if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return err(401, "unauthorized");
  if (!/^[\w.-]+$/.test(name)) return err(400, "bad name");
  await env.AUDIO.put(`releases/${name}`, request.body);
  return json({ ok: true, name });
}

async function releaseDownload(env, name) {
  if (!/^[\w.-]+$/.test(name)) return err(400, "bad name");
  const obj = await env.AUDIO.get(`releases/${name}`);
  if (!obj) return err(404, "not found");
  return new Response(obj.body, { headers: {
    "content-type": name.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/octet-stream",
    "content-disposition": `attachment; filename="${name}"`,
    "content-length": String(obj.size),
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  }});
}

/**
 * 内置语音（内测公开路由，按 IP 限额）：客户端开箱即用，无需用户申请任何语音 key。
 * secrets: AZURE_SPEECH_REGION / AZURE_SPEECH_KEY
 */
async function rateLimit(env, request, kind, perDay) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const k = `rl:${kind}:${ip}:${day()}`;
  const n = parseInt(await env.KV.get(k) || "0", 10) + 1;
  await env.KV.put(k, String(n), { expirationTtl: 90000 });
  return n <= perDay;
}

async function speechAsr(env, request, url) {
  if (!env.AZURE_SPEECH_KEY) return err(503, "speech not configured");
  if (!(await rateLimit(env, request, "asr", 200))) return err(429, "今日语音识别额度已用完");
  const lang = url.searchParams.get("lang") || "zh-CN";
  const resp = await fetch(
    `https://${env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}&format=simple`,
    { method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000" },
      body: request.body });
  if (!resp.ok) return err(502, `speech upstream ${resp.status}`);
  const data = await resp.json();
  if (data.RecognitionStatus !== "Success" || !data.DisplayText) return err(422, "没听清");
  return json({ text: data.DisplayText });
}

async function speechTts(env, request, body) {
  if (!env.AZURE_SPEECH_KEY) return err(503, "speech not configured");
  if (!body.text) return err(400, "text required");
  if (!(await rateLimit(env, request, "tts", 600))) return err(429, "今日发音额度已用完");
  const lang = body.lang === "yue" ? "yue" : "en";
  // 音色白名单：客户端可选，非法值回落默认
  const VOICES = {
    en: ["en-US-AvaMultilingualNeural", "en-US-AndrewMultilingualNeural", "en-US-JennyNeural", "en-US-GuyNeural"],
    yue: ["zh-HK-HiuMaanNeural", "zh-HK-HiuGaaiNeural", "zh-HK-WanLungNeural"],
  };
  const pool = VOICES[lang];
  const voice = pool.includes(body.voice) ? body.voice : pool[0];
  const xmlLang = lang === "yue" ? "zh-HK" : "en-US";
  const esc = String(body.text).slice(0, 500).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ssml = `<speak version='1.0' xml:lang='${xmlLang}'><voice name='${voice}'>${esc}</voice></speak>`;
  const resp = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "yiko-api" },
    body: ssml });
  if (!resp.ok) return err(502, `tts upstream ${resp.status}`);
  return new Response(resp.body, { headers: { "content-type": "audio/mpeg", "access-control-allow-origin": "*" } });
}

/**
 * 声音克隆（内置，MiniMax）：录音→克隆→带音色合成。
 * 设备标识用 x-device 头，每设备限 MAX_CLONES 个音色。
 * secrets: MINIMAX_KEY
 */
const MAX_CLONES = 2;

async function cloneCreate(env, request) {
  if (!env.MINIMAX_KEY) return err(503, "clone not configured");
  const device = request.headers.get("x-device") || request.headers.get("cf-connecting-ip") || "unknown";
  // 限次
  const cntKey = `clones:${device}`;
  const owned = JSON.parse(await env.KV.get(cntKey) || "[]");
  if (owned.length >= MAX_CLONES) return err(429, `每台设备最多克隆 ${MAX_CLONES} 个声音`);
  // 1) 转发录音到 MiniMax 上传
  const form = new FormData();
  form.append("purpose", "voice_clone");
  const buf = await request.arrayBuffer();
  form.append("file", new Blob([buf], { type: "audio/mp4" }), "voice.m4a");
  const up = await fetch("https://api.minimaxi.com/v1/files/upload", {
    method: "POST", headers: { "Authorization": `Bearer ${env.MINIMAX_KEY}` }, body: form });
  const upj = await up.json();
  const fileId = upj?.file?.file_id;
  if (!fileId) return err(502, "upload failed: " + JSON.stringify(upj?.base_resp || upj).slice(0, 160));
  // 2) 克隆 + 生成试听
  const voiceId = "yk" + device.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) + Date.now().toString(36);
  const cl = await fetch("https://api.minimaxi.com/v1/voice_clone", {
    method: "POST", headers: { "Authorization": `Bearer ${env.MINIMAX_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, voice_id: voiceId,
      text: "这是我的声音，我在用 Yiko 练口语。", model: "speech-2.6-hd" }) });
  const clj = await cl.json();
  if (clj?.base_resp?.status_code !== 0) return err(502, "clone failed: " + (clj?.base_resp?.status_msg || "unknown"));
  // 记录归属
  owned.push(voiceId);
  await env.KV.put(cntKey, JSON.stringify(owned));
  return json({ voice_id: voiceId, demo_audio: clj.demo_audio || null });
}

async function cloneTts(env, request, body) {
  if (!env.MINIMAX_KEY) return err(503, "clone not configured");
  if (!body.text || !body.voice_id) return err(400, "text and voice_id required");
  if (!/^yk[a-zA-Z0-9]+$/.test(body.voice_id)) return err(400, "bad voice_id");
  if (!(await rateLimit(env, request, "clonetts", 600))) return err(429, "今日发音额度已用完");
  const resp = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
    method: "POST", headers: { "Authorization": `Bearer ${env.MINIMAX_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "speech-2.6-hd", text: String(body.text).slice(0, 500), stream: false,
      // 语种提示：粤语必须显式指定，否则克隆音色按普通话读粤文
      language_boost: body.lang === "yue" ? "Chinese,Yue" : (body.lang === "en" ? "English" : "auto"),
      voice_setting: { voice_id: body.voice_id, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: "mp3", sample_rate: 24000 } }) });
  const j = await resp.json();
  if (j?.base_resp?.status_code !== 0 || !j?.data?.audio) return err(502, "tts failed: " + (j?.base_resp?.status_msg || "unknown"));
  // hex → bytes
  const hex = j.data.audio;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return new Response(bytes, { headers: { "content-type": "audio/mpeg", "access-control-allow-origin": "*" } });
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    if (m === "OPTIONS") return new Response(null, { headers: {
      "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-device" } });

    try {
      if (m === "GET" && p === "/v1/health") return health(env);
      if (m === "PUT" && p.startsWith("/admin/release/")) return releaseUpload(env, request, p.slice("/admin/release/".length));
      if ((m === "GET" || m === "HEAD") && p.startsWith("/dl/")) return releaseDownload(env, p.slice(4));
      if ((m === "GET" || m === "HEAD") && p === "/yiko.apk") return releaseDownload(env, "yiko.apk");
      if (m === "GET" && p === "/v1/version") return json({ version: VERSION });
      if (m === "POST" && p === "/v1/speech/asr") return speechAsr(env, request, url);
      if (m === "POST" && p === "/v1/speech/tts") return speechTts(env, request, await request.json().catch(() => ({})));
      if (m === "POST" && p === "/v1/voice/clone") return cloneCreate(env, request);
      if (m === "POST" && p === "/v1/voice/tts") return cloneTts(env, request, await request.json().catch(() => ({})));

      const body = (m === "POST" || m === "PUT") ? await request.json().catch(() => ({})) : {};

      if (m === "POST" && p === "/v1/auth/otp/request") return otpRequest(env, body);
      if (m === "POST" && p === "/v1/auth/otp/verify") return otpVerify(env, body);

      // 以下路由需要登录
      const userId = await auth(env, request);
      if (!userId) return err(401, "unauthorized");

      if (m === "GET" && p === "/v1/me") return me(env, userId);
      if (m === "POST" && p === "/v1/generate") return generate(env, userId, body);
      if (m === "POST" && p === "/v1/tts") return tts(env, userId, body);
      if (m === "GET" && p === "/v1/sync/sentences") return syncGet(env, userId, "sentences", Number(url.searchParams.get("since") || 0));
      if (m === "PUT" && p === "/v1/sync/sentences") return syncPutSentences(env, userId, body.items || []);
      if (m === "GET" && p === "/v1/sync/words") return syncGet(env, userId, "words", Number(url.searchParams.get("since") || 0));
      if (m === "PUT" && p === "/v1/sync/words") return syncPutWords(env, userId, body.items || []);
      if (m === "POST" && p === "/v1/events") return trackEvent(env, userId, body);

      return err(404, "not found");
    } catch (e) {
      return err(500, String(e.message || e).slice(0, 200));
    }
  },
};
