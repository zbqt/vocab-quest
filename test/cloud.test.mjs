import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const require = createRequire(import.meta.url);
const VQCloud = require("../cloud-sync.js");

const DAY = 86400000;

/* ================= 载荷打包 ================= */

test("buildPayload 去掉页面临时键，保留存档主体", () => {
  const state = { v: 3, coin: 100, words: { apple: { seen: 2 } }, open_1: true, open_2: false, events: [] };
  const p = VQCloud.buildPayload(state, 1700000000000);
  assert.equal(p.state.coin, 100);
  assert.deepEqual(p.state.words, { apple: { seen: 2 } });
  assert.equal(p.state.open_1, undefined, "open_* 是页面临时状态，不该进云端");
  assert.equal(p.state.open_2, undefined);
  assert.equal(p.savedAt, 1700000000000);
});

test("buildPayload 不改动原始存档对象", () => {
  const state = { words: { a: { seen: 1 } }, events: [{ type: "answer", ts: Date.now() }] };
  const before = JSON.stringify(state);
  const p = VQCloud.buildPayload(state);
  assert.equal(JSON.stringify(state), before, "打包必须是纯函数，不能顺手改本地存档");
  assert.equal(p.state.events.length, 1);
});

test("trimEvents 丢掉过老的日志，只留最近几天", () => {
  const now = Date.now();
  const ev = [
    { type: "answer", ts: now - 30 * DAY },
    { type: "answer", ts: now - 2 * DAY },
    { type: "answer", ts: now - 1 * DAY }
  ];
  const out = VQCloud.trimEvents(ev);
  assert.equal(out.length, 2, "30 天前的日志不该再上传");
  assert.ok(out.every((e) => e.ts > now - 9 * DAY));
});

test("trimEvents 日志最多留 600 条，挡住无限膨胀", () => {
  const now = Date.now();
  const ev = Array.from({ length: 900 }, (_, i) => ({ type: "answer", ts: now - i * 1000 }));
  assert.equal(VQCloud.trimEvents(ev).length, 600);
});

test("trimEvents 忽略脏条目", () => {
  assert.deepEqual(VQCloud.trimEvents(null), []);
  assert.equal(VQCloud.trimEvents([null, "x", { ts: Date.now() }]).length, 1);
});

/* ================= 同步决策 ================= */

const at = (d) => new Date(d).toISOString();

test("decideSync：云端没有存档 → 新建上传", () => {
  assert.equal(VQCloud.decideSync({}, null, false), "create");
  assert.equal(VQCloud.decideSync({ rev: 3 }, null, true), "create");
});

test("decideSync：新设备一个字都没学过 → 直接接云端存档", () => {
  const remote = { client_rev: 5, client_saved_at: at(Date.now() - DAY) };
  assert.equal(VQCloud.decideSync({}, remote, false), "adopt");
  assert.equal(VQCloud.decideSync({ rev: 0, pushedRev: 0, pulledRev: 0 }, remote, false), "adopt");
});

test("decideSync：本机有进度但云端也有 → 不自动覆盖", () => {
  const remote = { client_rev: 5, client_saved_at: at(Date.now() - DAY) };
  assert.notEqual(VQCloud.decideSync({}, remote, true), "adopt");
});

test("decideSync：云端版本没变、本机有新改动 → 上传", () => {
  const remote = { client_rev: 7, client_saved_at: at(Date.now() - 2 * DAY) };
  const meta = { rev: 9, pushedRev: 7, pulledRev: 7, savedAt: Date.now() };
  assert.equal(VQCloud.decideSync(meta, remote, true), "push");
});

test("decideSync：两边已经一致 → 什么都不做", () => {
  const remote = { client_rev: 7, client_saved_at: at(Date.now() - DAY) };
  const meta = { rev: 7, pushedRev: 7, pulledRev: 7, savedAt: Date.now() - DAY };
  assert.equal(VQCloud.decideSync(meta, remote, true), "in-sync");
});

test("decideSync：别的设备推了更新的版本 → 交给人选", () => {
  const remote = { client_rev: 8, client_saved_at: at(Date.now()) };
  const meta = { rev: 7, pushedRev: 7, pulledRev: 7, savedAt: Date.now() - 3 * DAY };
  assert.equal(VQCloud.decideSync(meta, remote, true), "remote-newer");
});

test("decideSync：别的设备推过，但本机时间更晚 → 本机覆盖云端", () => {
  const remote = { client_rev: 8, client_saved_at: at(Date.now() - 3 * DAY) };
  const meta = { rev: 9, pushedRev: 7, pulledRev: 7, savedAt: Date.now() };
  assert.equal(VQCloud.decideSync(meta, remote, true), "push");
});

test("decideSync：client_saved_at 缺失不炸，按本机更晚处理", () => {
  const remote = { client_rev: 8, client_saved_at: null };
  const meta = { rev: 9, pushedRev: 7, pulledRev: 7, savedAt: Date.now() };
  assert.equal(VQCloud.decideSync(meta, remote, true), "push");
});

/* ================= 面板（没有 SDK / 没网时的降级表现） ================= */

const CLOUD_URL = "https://wbapp-uugfv7gc0fmksjuo3hokye.app.workbuddy.host/";

function bootPanel(opts = {}, url = CLOUD_URL) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="m"></div></body></html>', {
    url,
    runScripts: "outside-only"
  });
  const win = dom.window;
  win.eval(read("cloud-sync.js"));
  const before = win.document.head.querySelectorAll("script").length;
  const api = win.VQCloud.mount(win.document.getElementById("m"), opts);
  return { win, doc: win.document, api, scriptsAdded: () => win.document.head.querySelectorAll("script").length - before };
}

test("面板默认渲染登录表单，且不主动联网下载 SDK", () => {
  const { doc, scriptsAdded } = bootPanel();
  assert.ok(doc.querySelector('[data-r="login"]'), "应有登录按钮");
  assert.ok(doc.querySelector('[data-r="phone"]'), "默认用手机号登录");
  assert.equal(scriptsAdded(), 0, "用户没点之前不该加载云端 SDK");
});

test("手机号位数不对时拦在本地，不发请求", () => {
  const { doc, scriptsAdded } = bootPanel();
  const phone = doc.querySelector('[data-r="phone"]');
  phone.value = "1380000000";
  doc.querySelector('[data-r="send"]').click();
  assert.match(doc.querySelector('[data-r="err"]').textContent, /11 位手机号/);
  assert.equal(scriptsAdded(), 0, "校验失败不该触发任何网络请求");
});

test("切到邮箱登录后手机号输入框让位", () => {
  const { doc } = bootPanel();
  doc.querySelector('[data-r="tabEmail"]').click();
  assert.equal(doc.querySelector('[data-r="email"]').style.display, "block");
  assert.equal(doc.querySelector('[data-r="phone"]').style.display, "none");
});

test("验证码位数不对时不提交", () => {
  const { doc, scriptsAdded } = bootPanel();
  doc.querySelector('[data-r="code"]').value = "12";
  doc.querySelector('[data-r="login"]').click();
  assert.match(doc.querySelector('[data-r="err"]').textContent, /4-8 位/);
  assert.equal(scriptsAdded(), 0);
});

test("没先取码就登录：提示先去取码，不发认证请求", () => {
  const { doc, scriptsAdded } = bootPanel();
  doc.querySelector('[data-r="phone"]').value = "13800000000";
  doc.querySelector('[data-r="code"]').value = "123456";
  doc.querySelector('[data-r="login"]').click();
  assert.match(doc.querySelector('[data-r="err"]').textContent, /先点「获取验证码」/);
  assert.equal(scriptsAdded(), 0, "没有挑战时不该发起验证请求");
});

test("切换收件方式会作废上一次的验证挑战", () => {
  const { doc } = bootPanel();
  doc.querySelector('[data-r="phone"]').value = "13800000000";
  doc.querySelector('[data-r="code"]').value = "123456";
  doc.querySelector('[data-r="tabEmail"]').click();
  doc.querySelector('[data-r="login"]').click();
  assert.match(doc.querySelector('[data-r="err"]').textContent, /先点「获取验证码」/);
});

test("从 GitHub Pages 打开：不摆必然失败的登录框，直接给换地址的出口", () => {
  const { doc } = bootPanel({}, "https://zbqt.github.io/vocab-quest/");
  assert.equal(doc.querySelector('[data-r="signedOut"]').style.display, "none", "异地域名下登录框应隐藏");
  assert.equal(doc.querySelector('[data-r="offsite"]').style.display, "block");
  assert.match(doc.querySelector('[data-r="offsiteText"]').textContent, /zbqt\.github\.io/);
  assert.match(doc.querySelector('[data-r="offsiteText"]').textContent, /本地存档不受影响/);
  assert.equal(
    doc.querySelector('[data-r="offsiteLink"]').getAttribute("href"),
    "https://wbapp-uugfv7gc0fmksjuo3hokye.app.workbuddy.host/"
  );
  assert.equal(doc.querySelector('[data-r="state"]').textContent, "仅本地");
});

/* ================= 页面接线 ================= */

test("game.html 引了 cloud-sync.js 并挂了面板容器", () => {
  const html = read("game.html");
  assert.match(html, /<script src="cloud-sync\.js"><\/script>/);
  assert.match(html, /id="cloudMount"/);
  assert.match(html, /VQCloud\.mount\(document\.getElementById\("cloudMount"\)/);
});

test("index.html 也能登录并看到云端存档数量", () => {
  const html = read("index.html");
  assert.match(html, /<script src="cloud-sync\.js"><\/script>/);
  assert.match(html, /id="cloudMount"/);
});

test("cloud-sync.js 初始化时带齐 endpoint / publishableKey / oauthRelayBaseUrl", () => {
  const src = read("cloud-sync.js");
  const call = src.slice(src.indexOf("createWorkBuddyCloud({"), src.indexOf("createWorkBuddyCloud({") + 400);
  assert.match(call, /endpoint:\s*PUBLIC_CONFIG\.endpoint/);
  assert.match(call, /publishableKey:\s*PUBLIC_CONFIG\.publishableKey/);
  assert.match(call, /oauthRelayBaseUrl:\s*PUBLIC_CONFIG\.oauthRelayBaseUrl/);
  assert.match(src, /endpoint:\s*"https:\/\/[^"]+"/, "endpoint 必须来自激活下发的 publicConfig");
});

test("离线缓存清单包含新文件，版本号已递增", () => {
  const sw = read("sw.js");
  assert.match(sw, /"\.\/cloud-sync\.js"/);
  assert.match(sw, /VERSION = "vq-v\d+"/, "改了静态资源就要升缓存版本，否则老用户会一直吃旧缓存");
});

test("PWA 的 start_url 带分享码，否则加到桌面后点开是 403", () => {
  const mf = JSON.parse(read("manifest.webmanifest"));
  // 发布站不带 sharecode 直接返回 403（实测），start_url 丢了参数图标就是个死链
  assert.match(mf.start_url, /sharecode=/, "start_url 必须带 sharecode，否则主屏图标点开是 403 错误页");
  assert.match(mf.start_url, /^\.\//, "start_url 用相对路径，换域名不用改");
  assert.equal(mf.scope, "./");
  assert.equal(mf.display, "standalone");
});
