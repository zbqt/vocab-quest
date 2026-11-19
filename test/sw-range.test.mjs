/* 录音的 Range 请求。
 *
 * 媒体元素取音频时几乎一定带 `Range: bytes=0-`。以前一律把整个 200 响应丢回去：
 * Chrome 能凑合播，iOS 会当作"服务器不支持分段"反复重试、甚至判定加载失败 ——
 * 表现就是「点了要等很久」或者「离线点了没声音」。
 *
 * 这一组把 sw.js 真的放进沙箱里跑一遍 fetch 事件，检查回的是不是它要的那几个字节。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

const ORIGIN = "https://vq.test";
const AUDIO = ORIGIN + "/audio/w/ab/able.mp3";

/* 把 sw.js 装进一个假的全局：只要能注册上事件、能拿到 fetch 处理器就够了 */
function bootSW(cached, net) {
  const handlers = {};
  const opened = [];
  const cacheObj = {
    match: async () => cached,
    put: async () => {},
    add: async () => {}
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener(name, fn) { handlers[name] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const caches = {
    open: async (name) => { opened.push(name); return cacheObj; },
    keys: async () => [],
    match: async () => cached,
    delete: async () => true
  };
  const netReqs = [];
  const ctx = vm.createContext({
    self, caches, Response, Headers, Request, URL, URLSearchParams, Promise, console,
    fetch: async (r) => {
      netReqs.push(r);
      if (!net) throw new Error("断网");
      return net(r);
    }
  });
  vm.runInContext(SW, ctx);

  /* 触发一次 fetch，拿回它要的响应 */
  async function run({ url, range, mode }) {
    const headers = new Headers(range ? { range } : {});
    const request = { method: "GET", url, mode: mode || "no-cors", headers };
    let out = null;
    handlers.fetch({ request, respondWith(p) { out = p; } });
    return out ? await out : null;
  }
  return { run, opened, netReqs };
}

const BODY = new Uint8Array(1000);
for (let i = 0; i < BODY.length; i++) BODY[i] = i % 256;

test("录音命中缓存 + Range：回 206 和它要的那一段，而不是整个文件", async () => {
  const cached = new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  const { run } = bootSW(cached);
  const res = await run({ url: AUDIO, range: "bytes=100-199" });

  assert.equal(res.status, 206, "带 Range 必须回 206，回 200 会让 iOS 判定不支持分段");
  assert.equal(res.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  const got = new Uint8Array(await res.arrayBuffer());
  assert.equal(got.length, 100, "字节数要正好是 100");
  assert.equal(got[0], 100);
  assert.equal(got[99], 199);
});

test("录音命中缓存 + 开放区间（bytes=900-）：一路给到文件尾", async () => {
  const cached = new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  const { run } = bootSW(cached);
  const res = await run({ url: AUDIO, range: "bytes=900-" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 900-999/1000");
  assert.equal((await res.arrayBuffer()).byteLength, 100);
});

test("录音命中缓存 + 没有 Range：照旧回完整文件", async () => {
  const cached = new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  const { run } = bootSW(cached);
  const res = await run({ url: AUDIO });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 1000);
});

test("Range 越界：回 416 并说明真实长度，别把坏数据塞回去", async () => {
  const cached = new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  const { run } = bootSW(cached);
  const res = await run({ url: AUDIO, range: "bytes=2000-3000" });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("Content-Range"), "bytes */1000");
});

test("打开缓存只做一次：每个音频请求都重新 open 的话，点一下就要多等几十毫秒", async () => {
  const cached = new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  const { run, opened } = bootSW(cached);
  await run({ url: AUDIO });
  await run({ url: ORIGIN + "/audio/w/te/tell.mp3" });
  await run({ url: AUDIO });
  assert.equal(opened.length, 1, "同一个分区被重复 open 了 " + opened.length + " 次");
});

test("页面脚本不该去查录音分区：那里有 6 千多条，每次查都要过一遍", async () => {
  const { run, opened } = bootSW(null);
  await run({ url: ORIGIN + "/tts.js?v=1", mode: "same-origin" }).catch(() => {});
  // 壳分区被打开是正常的；关键是没把所有分区都拿出来遍历
  assert.ok(opened.length <= 1, "静态资源只该打开「壳」这一个分区，实际：" + opened.join(","));
});

test("缓存没命中 + 带 Range 请求：按完整文件去取（不带 Range），别把半截存进本机", async () => {
  let seenRange = "未发起请求";
  const net = (req) => {
    // 真实 Request 对象：能读到它到底有没有带 Range 头
    seenRange = req.headers.get("range");
    return new Response(BODY, { headers: { "Content-Type": "audio/mpeg" } });
  };
  const { run } = bootSW(null, net);
  const res = await run({ url: AUDIO, range: "bytes=0-99" });

  assert.equal(seenRange, null, "取网络时不能带 Range：带了只能拿回 206 半截，半截存不进缓存");
  assert.equal(res.status, 206, "给客户端的那一份仍要按它要的区间切 206");
  assert.equal(res.headers.get("Content-Range"), "bytes 0-99/1000");
  assert.equal((await res.arrayBuffer()).byteLength, 100);
});
