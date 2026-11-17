/*!
 * VQCloud — 单词闯关的云服务接入层（账号登录 + 学习进度云端备份）
 *
 * 设计约束：
 * 1. 本地存档永远是主存档。没登录、断网、SDK 加载失败时，页面照常使用，不降级、不假装成功
 * 2. 云端只做「备份 + 换设备恢复」，不做实时多端合并；冲突时让人来选，绝不静默覆盖
 * 3. 不碰 document 之外的页面逻辑；页面只提供「读出存档 / 写入存档」两个钩子
 *
 * 依赖：@tencent-ai/workbuddy-cloud-sdk（CDN 全局 WorkBuddyCloud），按需懒加载
 */
(function (root) {
  "use strict";

  /* publicConfig 由 workbuddy_cloud_service 激活时下发，属于可公开的前端配置 */
  var PUBLIC_CONFIG = {
    endpoint: "https://wbapp-uugfv7gc0fmksjuo3hokye.app.workbuddy.host",
    oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
    publishableKey: "wbpk_UUGfv7gC0fMKsJUo3HoKye_Z11vIoB2X2GxxL7XeiyxE3bX2p8y5fTK"
  };

  var SDK_URL = "https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js";
  var TABLE = "vq_progress";
  var SDK_TIMEOUT = 15000;
  var PUSH_DEBOUNCE = 4000;
  var EVENT_KEEP_DAYS = 8;   // 云端的答题日志只留最近 8 天（近 7 天视图够用，也控住存档体积）
  var EVENT_KEEP_MAX = 600;
  var HINT_KEY = "vq_cloud_seen";

  // 服务端按来源域名校验，只有应用自己的发布域名能登录；
  // GitHub Pages / file:// / 局域网 http 一律会被拒，提前说清楚，别让人以为是网速问题
  var CLOUD_ORIGIN = (function () {
    try { return new URL(PUBLIC_CONFIG.endpoint).origin; } catch (e) { return ""; }
  })();

  function onCloudOrigin() {
    if (!CLOUD_ORIGIN) return true;
    try { return root.location.origin === CLOUD_ORIGIN; } catch (e) { return false; }
  }

  var client = null;
  var sdkPromise = null;
  var session = null;
  var pendingOtp = null;
  var contexts = {};          // book -> { getState, applyState, hasProgress }
  var pushTimers = {};
  var mountState = null;      // 当前面板的内部状态

  /* ================= 存储小工具（无 localStorage 也不炸） ================= */

  function ls() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function readJSON(key) {
    var s = ls();
    if (!s) return null;
    try { var raw = s.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  function writeJSON(key, val) {
    var s = ls();
    if (!s) return;
    try { s.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function metaKey(book) { return "vq_cloud_meta_" + book; }
  function readMeta(book) { return readJSON(metaKey(book)) || {}; }
  function writeMeta(book, m) { writeJSON(metaKey(book), m); }

  /* ================= 错误归一化 ================= */

  function CloudError(kind, message) {
    var e = new Error(message || kind);
    e.kind = kind;
    e.friendly = message || "";
    return e;
  }

  var KIND_TEXT = {
    network: "网络连不上云端，检查一下 Wi-Fi 或代理再试",
    "backend-unavailable": "云服务暂时不可用，过一会儿再试",
    unauthenticated: "登录已失效，请重新登录",
    "invalid_grant": "验证码不对或已过期，重新获取一个",
    rate_limit: "请求太频繁了，等一分钟再试",
    "sdk-offline": "云端组件没加载成功（可能没网或被拦截），本地学习不受影响"
  };

  function toCloudError(err) {
    var kind = (err && (err.kind || err.code)) || "unknown";
    var fallback = KIND_TEXT[kind] || (err && err.message) || "云端操作失败，稍后再试";
    if (kind === "42501") fallback = "没有权限访问这条数据，请确认已登录";
    if (kind === "23505") fallback = "云端已有这条存档，请刷新后重试";
    if (kind === "42P01") fallback = "云端数据表还没建好，暂时无法同步";
    return CloudError(kind, fallback);
  }

  function reasonOf(e) {
    if (e && e.friendly) return e.friendly;
    if (e && e.kind === "timeout") return KIND_TEXT["sdk-offline"];
    if (e && e.message === "sdk-missing") return KIND_TEXT["sdk-offline"];
    if (e && (e.message === "network" || e.message === "timeout")) return KIND_TEXT["sdk-offline"];
    return (e && e.message) || "云端操作失败，稍后再试";
  }

  /* ================= SDK 懒加载 ================= */

  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    if (root.WorkBuddyCloud && typeof root.WorkBuddyCloud.createWorkBuddyCloud === "function") {
      sdkPromise = Promise.resolve();
      return sdkPromise;
    }
    sdkPromise = new Promise(function (resolve, reject) {
      if (!root.document) return reject(new Error("network"));
      var s = root.document.createElement("script");
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("timeout"));
      }, SDK_TIMEOUT);
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      s.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("network"));
      };
      root.document.head.appendChild(s);
    }).catch(function (e) {
      sdkPromise = null;          // 允许下次重试，不要把一次失败固化成永久不可用
      throw e;
    });
    return sdkPromise;
  }

  function ready() {
    if (client) return Promise.resolve(client);
    return loadSdk().then(function () {
      var WC = root.WorkBuddyCloud;
      if (!WC || typeof WC.createWorkBuddyCloud !== "function") throw new Error("sdk-missing");
      client = WC.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: PUBLIC_CONFIG.publishableKey
      });
      return client;
    });
  }

  /* ================= 会话 ================= */

  async function currentSession() {
    var c = await ready();
    var res = await c.auth.getSession();
    if (res && res.error) {
      session = null;
      throw toCloudError(res.error);
    }
    session = (res && res.data) || null;
    return session;
  }

  function cachedSession() { return session; }

  function userName(s) {
    return (s && s.user && typeof s.user.name === "string" && s.user.name) ? s.user.name : null;
  }

  function maskAccount(s) {
    var u = s && s.user;
    if (!u) return "";
    if (typeof u.phone === "string" && u.phone.length >= 7) {
      return u.phone.slice(0, 3) + "****" + u.phone.slice(-4);
    }
    if (typeof u.email === "string" && u.email.indexOf("@") > 0) {
      var at = u.email.indexOf("@");
      var namePart = u.email.slice(0, at);
      var keep = namePart.slice(0, Math.min(2, namePart.length));
      return keep + "***" + u.email.slice(at);
    }
    return "";
  }

  /* ================= 登录（手机号 / 邮箱验证码） ================= */

  async function requestCode(id) {
    var c = await ready();
    var res = await c.auth.sendOtp(id);
    if (res && res.error) throw toCloudError(res.error);
    var d = (res && res.data) || {};
    pendingOtp = { verificationId: d.verificationId, isExistingUser: !!d.isExistingUser };
    if (id.phone) pendingOtp.phone = id.phone;
    if (id.email) pendingOtp.email = id.email;
    return pendingOtp;
  }

  async function submitCode(token) {
    if (!pendingOtp || !pendingOtp.verificationId) {
      throw CloudError("no-challenge", "请先点「获取验证码」");
    }
    var c = await ready();
    var body = {
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token: String(token || "").trim()
    };
    if (pendingOtp.phone) body.phone = pendingOtp.phone;
    if (pendingOtp.email) body.email = pendingOtp.email;

    var res = await c.auth.verifyOtp(body);
    if (res && res.error) throw toCloudError(res.error);
    pendingOtp = null;
    // 以服务端会话为准，不拿返回值自己拼一个"已登录"
    var s = await currentSession();
    if (!s) throw CloudError("unauthenticated", "登录没有完成，请重试");
    var store = ls();
    if (store) { try { store.setItem(HINT_KEY, "1"); } catch (e) {} }
    return s;
  }

  async function signOut() {
    try {
      var c = await ready();
      await c.auth.signOut();
    } catch (e) { /* 网络失败也要把本地会话清掉 */ }
    session = null;
    pendingOtp = null;
    var store = ls();
    if (store) { try { store.removeItem(HINT_KEY); } catch (e) {} }
    Object.keys(contexts).forEach(function (b) {
      var m = readMeta(b);
      m.pushedRev = 0; m.pulledRev = 0;   // 换了账号，下次同步当全新开始
      writeMeta(b, m);
    });
  }

  /* ================= 存档载荷 ================= */

  function trimEvents(ev) {
    var cut = Date.now() - EVENT_KEEP_DAYS * 86400000;
    var out = [];
    (ev || []).forEach(function (e) {
      if (!e || typeof e !== "object") return;
      if (typeof e.ts === "number" && e.ts < cut) return;
      out.push(e);
    });
    return out.slice(-EVENT_KEEP_MAX);
  }

  /** 打包成云端存档：去掉页面临时键、日志只留最近几天，其余原样带上 */
  function buildPayload(state, now) {
    now = now || Date.now();
    var copy = {};
    Object.keys(state || {}).forEach(function (k) {
      if (k.indexOf("open_") === 0) return;
      if (k === "events") return;
      copy[k] = state[k];
    });
    copy.events = trimEvents((state && state.events) || []);
    return { savedAt: now, state: copy };
  }

  /**
   * 纯决策：本机存档 vs 云端存档该走哪条路。
   * 返回 create | adopt | in-sync | push | remote-newer
   */
  function decideSync(meta, remote, hasLocalProgress) {
    meta = meta || {};
    if (!remote) return "create";
    var remoteRev = remote.client_rev || 0;
    var remoteAt = remote.client_saved_at ? Date.parse(remote.client_saved_at) || 0 : 0;

    // 新设备 / 换手机：本机一个字都没学过，直接把云端存档接过来
    if (!hasLocalProgress && !((meta.pushedRev || 0) > 0)) return "adopt";

    if (remoteRev === (meta.pulledRev || 0)) {
      // 云端还是上次拿到的那份，本机有新改动就上传，否则已经一致
      return (meta.rev || 0) > (meta.pushedRev || 0) ? "push" : "in-sync";
    }
    // 别的设备推过新版本：谁的时间更晚听谁的，但"云端更晚"只提示，不自动覆盖
    if (remoteAt > (meta.savedAt || 0)) return "remote-newer";
    return "push";
  }

  /* ================= 数据读写 ================= */

  async function pullRemote(book) {
    var c = await ready();
    var res = await c.database
      .from(TABLE)
      .select("payload,client_rev,client_saved_at,owner_name")
      .eq("book", book)
      .maybeSingle();
    if (res && res.error) throw toCloudError(res.error);
    return (res && res.data) || null;
  }

  async function pushRemote(book) {
    var ctx = contexts[book];
    if (!ctx) throw CloudError("no-context", "这个页面没有可同步的存档");
    var c = await ready();
    var s = await currentSession();
    if (!s) throw CloudError("unauthenticated", "请先登录再同步");

    var m = readMeta(book);
    var rev = Math.max(m.rev || 0, m.pulledRev || 0) + 1;
    var savedAt = m.savedAt || Date.now();
    var row = {
      book: book,
      owner_name: userName(s),
      payload: buildPayload(ctx.getState()),
      client_rev: rev,
      client_saved_at: new Date(savedAt).toISOString()
    };

    var res = await c.database.from(TABLE).upsert(row, { onConflict: "owner_id,book" }).select("client_rev");
    if (res && res.error) throw toCloudError(res.error);
    var rows = (res && res.data) || [];
    if (rows.length === 0) throw CloudError("rls-blocked", "云端没有接受这次写入，请重新登录后再试");

    m.rev = rev; m.pushedRev = rev; m.pulledRev = rev; m.lastSyncAt = Date.now();
    m.savedAt = savedAt;
    writeMeta(book, m);
    return { rev: rev, at: savedAt };
  }

  function applyRemote(book, remote) {
    var ctx = contexts[book];
    if (!ctx) throw CloudError("no-context", "这个页面没有可恢复的存档");
    var st = remote && remote.payload && remote.payload.state;
    if (!st || typeof st !== "object") throw CloudError("bad-payload", "云端存档是空的或格式不对，没有覆盖本机");

    ctx.applyState(st);

    var m = readMeta(book);
    m.rev = remote.client_rev || 0;
    m.pushedRev = remote.client_rev || 0;
    m.pulledRev = remote.client_rev || 0;
    m.savedAt = remote.client_saved_at ? (Date.parse(remote.client_saved_at) || Date.now()) : Date.now();
    m.lastSyncAt = Date.now();
    writeMeta(book, m);
  }

  async function syncNow(book) {
    var m = readMeta(book);
    var remote = await pullRemote(book);
    var ctx = contexts[book];
    var hasLocal = ctx && ctx.hasProgress ? !!ctx.hasProgress() : false;
    var action = decideSync(m, remote, hasLocal);

    if (action === "create") { await pushRemote(book); return { status: "created" }; }
    if (action === "adopt") { applyRemote(book, remote); return { status: "adopted", remote: remote }; }
    if (action === "push") { await pushRemote(book); return { status: "pushed" }; }
    if (action === "remote-newer") { return { status: "remote-newer", remote: remote }; }
    return { status: "in-sync" };
  }

  function schedulePush(book) {
    if (!book || !contexts[book]) return;
    if (pushTimers[book]) clearTimeout(pushTimers[book]);
    pushTimers[book] = setTimeout(function () {
      pushTimers[book] = null;
      if (!session) return;
      pushRemote(book).then(function () {
        if (mountState && mountState.book === book) renderSyncLine();
      }).catch(function () { /* 静默重试：下一次保存还会再排一次 */ });
    }, PUSH_DEBOUNCE);
  }

  /** 页面每次存档后调用：记一个版本号 + 排一次防抖上传（没登录就只记版本号） */
  function touch(book) {
    if (!book) return;
    var m = readMeta(book);
    m.rev = (m.rev || 0) + 1;
    m.savedAt = Date.now();
    writeMeta(book, m);
    if (session) schedulePush(book);
  }

  function flush() {
    if (!session) return Promise.resolve(false);
    var jobs = Object.keys(pushTimers).filter(function (b) { return pushTimers[b]; }).map(function (b) {
      clearTimeout(pushTimers[b]);
      pushTimers[b] = null;
      return pushRemote(b).catch(function () {});
    });
    return Promise.all(jobs).then(function () { return jobs.length > 0; });
  }

  /* ================= 面板 UI ================= */

  var STYLE = [    ".vqc{background:#fff;border:1px solid #eef0f6;border-radius:18px;padding:18px 18px 16px;box-shadow:0 2px 10px rgba(31,36,48,.04);font-family:inherit;color:#1f2430;margin:14px 0}",
    ".vqc *{box-sizing:border-box}",
    ".vqc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}",
    ".vqc-title{font-size:15px;font-weight:800}",
    ".vqc-state{font-size:11px;font-weight:700;color:#6b7280;background:#f3f5fa;border-radius:999px;padding:3px 9px}",
    ".vqc-state.ok{color:#0f766e;background:#e7f7f2}",
    ".vqc-state.warn{color:#b45309;background:#fff5e5}",
    ".vqc-hint{font-size:12.5px;color:#6b7280;line-height:1.7;margin-bottom:12px}",
    ".vqc-tabs{display:flex;gap:6px;margin-bottom:12px}",
    ".vqc-tabs button{flex:1;border:1px solid #e5e8f2;background:#f8f9fd;color:#6b7280;font-size:13px;font-weight:700;padding:8px;border-radius:10px;cursor:pointer}",
    ".vqc-tabs button.on{background:#eef1ff;border-color:#c7cfff;color:#5b6cff}",
    ".vqc input{width:100%;border:1px solid #e5e8f2;background:#fbfcff;border-radius:11px;padding:11px 12px;font-size:15px;font-family:inherit;margin-bottom:9px;outline:none}",
    ".vqc input:focus{border-color:#b6c0ff;background:#fff}",
    ".vqc-row{display:flex;gap:8px;align-items:stretch}",
    ".vqc-row input{margin-bottom:9px}",
    ".vqc button{font-family:inherit}",
    ".vqc-send{white-space:nowrap;border:1px solid #d9ddff;background:#eef1ff;color:#5b6cff;font-weight:700;font-size:13px;border-radius:11px;padding:0 14px;margin-bottom:9px;cursor:pointer}",
    ".vqc-send:disabled{opacity:.55;cursor:default}",
    ".vqc-primary{width:100%;border:0;background:linear-gradient(135deg,#6c7bff,#5b6cff);color:#fff;font-size:15px;font-weight:800;padding:12px;border-radius:12px;cursor:pointer;box-shadow:0 6px 16px rgba(91,108,255,.22)}",
    ".vqc-primary:disabled{opacity:.6;cursor:default;box-shadow:none}",
    ".vqc-ghost{border:1px solid #e5e8f2;background:#fff;color:#4b5563;font-size:13px;font-weight:700;padding:10px 12px;border-radius:11px;cursor:pointer;flex:1}",
    ".vqc-ghost:disabled{opacity:.5;cursor:default}",
    ".vqc-err{font-size:12.5px;color:#dc2626;margin-top:9px;line-height:1.6;min-height:1px}",
    ".vqc-msg{font-size:12.5px;color:#0f766e;margin-top:9px;line-height:1.6}",
    ".vqc-user{display:flex;align-items:center;gap:11px;margin-bottom:13px}",
    ".vqc-avatar{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#6c7bff,#5b6cff);color:#fff;font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}",
    ".vqc-name{font-size:14.5px;font-weight:800}",
    ".vqc-sub{font-size:12px;color:#9ca3af;margin-top:2px}",
    ".vqc-sync-time{font-size:12px;color:#6b7280;margin-bottom:9px;line-height:1.6}",
    ".vqc-conflict{background:#fff8ed;border:1px solid #fed7aa;border-radius:12px;padding:11px;margin:10px 0}",
    ".vqc-conflict p{font-size:12.5px;color:#92400e;line-height:1.7;margin-bottom:9px}",
    ".vqc-link{display:block;margin:12px auto 0;border:0;background:none;color:#9ca3af;font-size:12px;cursor:pointer;text-decoration:underline}",
    ".vqc-books{font-size:12.5px;color:#6b7280;line-height:1.7;margin:2px 0 10px}"
  ].join("");

  function injectStyle() {
    if (!root.document) return;
    if (root.document.getElementById("vq-cloud-style")) return;
    var st = root.document.createElement("style");
    st.id = "vq-cloud-style";
    st.textContent = STYLE;
    root.document.head.appendChild(st);
  }

  var TPL = [
    '<div class="vqc">',
    '  <div class="vqc-head"><div class="vqc-title">☁️ 云端存档</div><div class="vqc-state" data-r="state">未登录</div></div>',
    '  <div data-r="signedOut">',
    '    <p class="vqc-hint">登录后学习进度会存一份到云端，换手机、清缓存都能找回来。不登录也能照常背，进度只在本机。</p>',    '    <div class="vqc-tabs"><button type="button" data-r="tabPhone" class="on">手机号</button><button type="button" data-r="tabEmail">邮箱</button></div>',
    '    <input data-r="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="tel" placeholder="11 位手机号">',
    '    <input data-r="email" type="email" autocomplete="email" placeholder="邮箱地址" style="display:none">',
    '    <div class="vqc-row"><input data-r="code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="验证码"><button type="button" class="vqc-send" data-r="send">获取验证码</button></div>',
    '    <button type="button" class="vqc-primary" data-r="login">登录 / 注册</button>',
    '    <div class="vqc-err" data-r="err"></div>',
    '  </div>',
    '  <div data-r="signedIn" style="display:none">',
    '    <div class="vqc-user"><div class="vqc-avatar" data-r="avatar">V</div><div><div class="vqc-name" data-r="name">已登录</div><div class="vqc-sub" data-r="account"></div></div></div>',
    '    <div class="vqc-books" data-r="books" style="display:none"></div>',
    '    <div data-r="syncBox">',
    '      <div class="vqc-sync-time" data-r="syncTime">还没有同步过</div>',
    '      <div class="vqc-row"><button type="button" class="vqc-ghost" data-r="push">上传到云端</button><button type="button" class="vqc-ghost" data-r="pull">从云端恢复</button></div>',
    '      <div class="vqc-conflict" data-r="conflict" style="display:none">',
    '        <p>云端有一份比你本机更晚的存档（<span data-r="remoteTime"></span>）。用哪一份？选错会覆盖另一份。</p>',
    '        <div class="vqc-row"><button type="button" class="vqc-primary" style="font-size:13px;padding:10px" data-r="takeRemote">用云端的</button><button type="button" class="vqc-ghost" data-r="keepLocal">用本机的</button></div>',
    '      </div>',
    '    </div>',
    '    <button type="button" class="vqc-link" data-r="logout">退出登录</button>',
    '  </div>',
    '  <div data-r="offsite" style="display:none">',
    '    <p class="vqc-hint" data-r="offsiteText"></p>',
    '    <a class="vqc-primary" data-r="offsiteLink" style="display:block;text-align:center;text-decoration:none" href="#">换成应用地址打开</a>',
    '  </div>',
    '  <div class="vqc-msg" data-r="msg" style="display:none"></div>',
    '</div>'
  ].join("\n");

  function fmtTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    var today = new Date();
    var sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return (sameDay ? "今天 " : (d.getMonth() + 1) + "/" + d.getDate() + " ") + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function renderSyncLine() {
    var st = mountState;
    if (!st || !st.el) return;
    var box = st.el.querySelector('[data-r="syncTime"]');
    if (!box) return;
    if (!st.book) return;
    var m = readMeta(st.book);
    if (!m.lastSyncAt) {
      box.textContent = "这台设备还没和云端同步过";
    } else {
      var pending = (m.rev || 0) > (m.pushedRev || 0);
      box.textContent = "上次同步 " + fmtTime(m.lastSyncAt) + (pending ? " · 有新的本地改动待上传" : " · 已是最新");
    }
  }

  function setMsg(st, text, kind) {
    var el = st.el.querySelector('[data-r="msg"]');
    if (!el) return;
    el.textContent = text || "";
    el.style.display = text ? "block" : "none";
    el.style.color = kind === "warn" ? "#b45309" : "#0f766e";
  }

  function setErr(st, text) {
    var el = st.el.querySelector('[data-r="err"]');
    if (!el) return;
    el.textContent = text || "";
  }

  function setBusy(st, on) {
    ["send", "login", "push", "pull", "takeRemote", "keepLocal", "logout"].forEach(function (r) {
      var b = st.el.querySelector('[data-r="' + r + '"]');
      if (b) b.disabled = !!on;
    });
  }

  function showSignedIn(st, s) {
    st.el.querySelector('[data-r="signedOut"]').style.display = "none";
    st.el.querySelector('[data-r="signedIn"]').style.display = "block";
    var badge = st.el.querySelector('[data-r="state"]');
    badge.textContent = "已登录";
    badge.className = "vqc-state ok";

    var name = userName(s) || "已登录用户";
    st.el.querySelector('[data-r="name"]').textContent = name;
    st.el.querySelector('[data-r="avatar"]').textContent = name.slice(0, 1).toUpperCase();
    st.el.querySelector('[data-r="account"]').textContent = maskAccount(s);

    var box = st.el.querySelector('[data-r="syncBox"]');
    box.style.display = st.book ? "block" : "none";
    renderSyncLine();
    if (!st.book) loadBookCount(st);
  }

  function showSignedOut(st, note) {
    st.el.querySelector('[data-r="signedOut"]').style.display = "block";
    st.el.querySelector('[data-r="signedIn"]').style.display = "none";
    var badge = st.el.querySelector('[data-r="state"]');
    badge.textContent = note || "未登录";
    badge.className = "vqc-state";
  }

  async function loadBookCount(st) {
    try {
      var c = await ready();
      var res = await c.database.from(TABLE).select("book");
      if (res && res.error) throw toCloudError(res.error);
      var rows = (res && res.data) || [];
      var el = st.el.querySelector('[data-r="books"]');
      if (!el) return;
      el.textContent = rows.length
        ? "云端已有 " + rows.length + " 个词库的存档，进对应词库页面就能同步。"
        : "云端还没有存档，进任意词库学几关就会自动备份。";
      el.style.display = "block";
    } catch (e) {
      setMsg(st, reasonOf(e), "warn");
    }
  }

  async function doSync(st, quiet) {
    if (!st.book) return;
    if (!quiet) setBusy(st, true);
    try {
      var r = await syncNow(st.book);
      if (r.status === "adopted") {
        setMsg(st, "已把云端存档接到这台设备，进度已恢复");
      } else if (r.status === "pushed" || r.status === "created") {
        setMsg(st, "已上传到云端 " + fmtTime(Date.now()));
      } else if (r.status === "in-sync") {
        if (!quiet) setMsg(st, "两边已经一致，不用同步");
      } else if (r.status === "remote-newer") {
        var cf = st.el.querySelector('[data-r="conflict"]');
        st.el.querySelector('[data-r="remoteTime"]').textContent =
          fmtTime(r.remote && r.remote.client_saved_at ? Date.parse(r.remote.client_saved_at) : 0);
        cf.style.display = "block";
        st.cachedRemote = r.remote;
        setMsg(st, "云端存档比本机新，先选一份再继续", "warn");
      }
      renderSyncLine();
    } catch (e) {
      setMsg(st, reasonOf(e), "warn");
    } finally {
      setBusy(st, false);
    }
  }

  async function mount(el, opts) {
    opts = opts || {};
    if (!el || !root.document) return null;
    injectStyle();

    var st = {
      el: el,
      book: opts.book || null,
      cachedRemote: null,
      getState: opts.getState || function () { return {}; },
      hasProgress: opts.hasProgress || null,
      applyState: opts.applyState || function () {},
      onSignedIn: opts.onSignedIn || null
    };
    mountState = st;
    el.innerHTML = TPL;

    if (st.book) {
      contexts[st.book] = {
        getState: st.getState,
        hasProgress: st.hasProgress,
        applyState: function (payload) {
          st.applyState(payload);
        }
      };
    }

    var q = function (r) { return st.el.querySelector('[data-r="' + r + '"]'); };
    var mode = "phone";

    // 域名不对时：不摆一个必然失败的登录框，直接给出口
    if (!onCloudOrigin()) {
      st.offsite = true;
      q("signedOut").style.display = "none";
      q("offsite").style.display = "block";
      var badgeOff = q("state");
      badgeOff.textContent = "仅本地";
      badgeOff.className = "vqc-state warn";
      var here = "";
      try { here = root.location.host || "本地文件"; } catch (e) { here = "本地文件"; }
      q("offsiteText").textContent =
        "云端登录只认应用自己的域名，当前地址（" + here + "）会被服务端拒绝，换成下面的地址打开就能用。本机学习和本地存档不受影响。";
      q("offsiteLink").href = CLOUD_ORIGIN + "/";
      return {
        sync: function () { return Promise.resolve({ status: "offsite" }); },
        refresh: function () { return Promise.resolve(null); }
      };
    }

    function paintMode() {
      q("tabPhone").className = mode === "phone" ? "on" : "";
      q("tabEmail").className = mode === "email" ? "on" : "";
      q("phone").style.display = mode === "phone" ? "block" : "none";
      q("email").style.display = mode === "email" ? "block" : "none";
      pendingOtp = null;   // 换了收件方式，旧的验证挑战作废
      setErr(st, "");
    }
    q("tabPhone").onclick = function () { mode = "phone"; paintMode(); };
    q("tabEmail").onclick = function () { mode = "email"; paintMode(); };
    paintMode();
    // 手机号输入：只清错误，不发请求
    q("phone").addEventListener("input", function () { setErr(st, ""); });
    q("email").addEventListener("input", function () { setErr(st, ""); });

    var sendTimer = null;
    q("send").onclick = async function () {
      var id = null;
      if (mode === "phone") {
        var phone = q("phone").value.replace(/\s/g, "");
        if (!/^1\d{10}$/.test(phone)) { setErr(st, "请输入正确的 11 位手机号"); return; }
        id = { phone: phone };
      } else {
        var email = q("email").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr(st, "邮箱格式看起来不对"); return; }
        id = { email: email };
      }

      var btn = q("send");
      btn.disabled = true;
      btn.textContent = "发送中…";
      setErr(st, "");
      try {
        await requestCode(id);
        var left = 60;
        btn.textContent = left + "s 后重发";
        sendTimer = setInterval(function () {
          left--;
          if (left <= 0) {
            clearInterval(sendTimer);
            sendTimer = null;
            btn.disabled = false;
            btn.textContent = "重新获取";
          } else {
            btn.textContent = left + "s 后重发";
          }
        }, 1000);
        setMsg(st, "验证码已发出，填进上面的框里再点登录", "ok");
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "获取验证码";
        setErr(st, reasonOf(e));
      }
    };

    q("login").onclick = async function () {
      var token = q("code").value.replace(/\s/g, "");
      if (!/^\d{4,8}$/.test(token)) { setErr(st, "验证码是 4-8 位数字"); return; }

      // 收件人改过就必须重新取码：拿旧挑战去验新号码会得到莫名其妙的失败
      var current = mode === "phone" ? q("phone").value.replace(/\s/g, "") : q("email").value.trim();
      if (!pendingOtp || !pendingOtp.verificationId) { setErr(st, "请先点「获取验证码」"); return; }
      var sentTo = pendingOtp.phone || pendingOtp.email || "";
      if (sentTo !== current) {
        setErr(st, "验证码发给了另一个" + (mode === "phone" ? "号码" : "邮箱") + "，请重新获取");
        return;
      }

      setBusy(st, true);
      q("login").textContent = "登录中…";
      setErr(st, "");
      try {
        var s = await submitCode(token);
        showSignedIn(st, s);
        setMsg(st, "登录成功", "ok");
        if (st.onSignedIn) st.onSignedIn(s);
        await doSync(st, false);
      } catch (e) {
        setErr(st, reasonOf(e));
      } finally {
        setBusy(st, false);
        q("login").textContent = "登录 / 注册";
      }
    };

    q("code").addEventListener("keydown", function (e) {
      if (e.key === "Enter") q("login").click();
    });

    q("push").onclick = async function () {
      setBusy(st, true);
      setMsg(st, "");
      try {
        await pushRemote(st.book);
        setMsg(st, "已上传到云端 " + fmtTime(Date.now()), "ok");
        q("conflict").style.display = "none";
        renderSyncLine();
      } catch (e) {
        setMsg(st, reasonOf(e), "warn");
      } finally {
        setBusy(st, false);
      }
    };

    q("pull").onclick = async function () {
      setBusy(st, true);
      setMsg(st, "");
      try {
        var remote = await pullRemote(st.book);
        if (!remote) { setMsg(st, "云端还没有这个词库的存档", "warn"); return; }
        applyRemote(st.book, remote);
        setMsg(st, "已用云端存档覆盖本机（" + fmtTime(Date.parse(remote.client_saved_at) || 0) + "）", "ok");
        renderSyncLine();
      } catch (e) {
        setMsg(st, reasonOf(e), "warn");
      } finally {
        setBusy(st, false);
      }
    };

    q("takeRemote").onclick = function () {
      if (!st.cachedRemote) return;
      try {
        applyRemote(st.book, st.cachedRemote);
        q("conflict").style.display = "none";
        setMsg(st, "已用云端存档覆盖本机", "ok");
        renderSyncLine();
      } catch (e) {
        setMsg(st, reasonOf(e), "warn");
      }
    };

    q("keepLocal").onclick = async function () {
      q("conflict").style.display = "none";
      setBusy(st, true);
      try {
        await pushRemote(st.book);
        setMsg(st, "已用本机存档覆盖云端", "ok");
        renderSyncLine();
      } catch (e) {
        setMsg(st, reasonOf(e), "warn");
      } finally {
        setBusy(st, false);
      }
    };

    q("logout").onclick = async function () {
      setBusy(st, true);
      try { await signOut(); } catch (e) {}
      setBusy(st, false);
      showSignedOut(st);
      setMsg(st, "已退出。本机进度还在，重新登录后可以继续同步", "ok");
    };

    // 只有「之前登录过」的浏览器才自动加载 SDK，第一次来的用户不为它付流量
    var hint = ls() && ls().getItem(HINT_KEY);
    if (hint === "1") {
      showSignedOut(st, "连接中…");
      try {
        var s = await currentSession();
        if (s) {
          showSignedIn(st, s);
          await doSync(st, true);
        } else {
          showSignedOut(st);
        }
      } catch (e) {
        showSignedOut(st, "离线");
        setMsg(st, "云端暂时连不上，本地学习照常", "warn");
      }
    }

    return {
      sync: function () { return doSync(st, false); },
      refresh: function () { return currentSession(); }
    };
  }

  /* ================= 对外 ================= */

  var api = {
    PUBLIC_CONFIG: PUBLIC_CONFIG,
    ready: ready,
    mount: mount,
    touch: touch,
    flush: flush,
    syncNow: syncNow,
    pushRemote: pushRemote,
    pullRemote: pullRemote,
    applyRemote: applyRemote,
    buildPayload: buildPayload,
    decideSync: decideSync,
    trimEvents: trimEvents,
    currentSession: currentSession,
    cachedSession: cachedSession,
    requestCode: requestCode,
    submitCode: submitCode,
    signOut: signOut,
    reasonOf: reasonOf
  };

  root.VQCloud = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
