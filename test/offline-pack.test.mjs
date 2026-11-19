/* 离线发音包：清单、路径规则、断点续传、清除范围。
 *
 * 这几个点错了都是「静默失效」：下载了但播放读不到、删了不该删的、
 * 续传从头再来 —— 页面上看不出异常，只有用户断网时才发现没声。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const O = require(path.join(ROOT, "offline-pack.js"));
const T = require(path.join(ROOT, "tts.js"));

/* 极简 Cache API 替身：只要 keys / put / delete，够这个模块用 */
function fakeCaches() {
  const store = new Map();
  const abs = (u) => new URL(u, "https://vq.test/").href;
  return {
    store,
    open: async () => ({
      keys: async () => [...store.keys()].map((u) => ({ url: u })),
      put: async (u, res) => { store.set(abs(u), res || {}); },
      delete: async (req) => store.delete(req.url),
    }),
  };
}

function withEnv(fn) {
  const prevCaches = globalThis.caches;
  const prevFetch = globalThis.fetch;
  const fake = fakeCaches();
  globalThis.caches = fake;
  return Promise.resolve(fn(fake)).finally(() => {
    globalThis.caches = prevCaches;
    globalThis.fetch = prevFetch;
  });
}

test("路径规则与 tts.js 的 localSrc 完全一致", () => {
  // 两处各算一遍路径，只要有一个人改了规则，离线包就会下到另一批地址上
  for (const w of ["able", "abandon", "tell", "ha", "a", "give up", "Abandon", "", "x".repeat(20)]) {
    assert.equal(O.pathOf(w), T.VQSpeech.localSrc(w), "路径规则分叉了：" + JSON.stringify(w));
  }
});

test("缓存名与 sw.js 的 AUDIO_CACHE 一致", () => {
  const m = read("sw.js").match(/const AUDIO_CACHE = "([^"]+)"/);
  assert.ok(m, "sw.js 里没找到 AUDIO_CACHE");
  assert.equal(O.CACHE, m[1], "两处缓存名不一致：下载了播放时读不到");
});

test("清单里的每个词都真有对应文件，文件也不漏在清单外", () => {
  const man = JSON.parse(read("audio-manifest.json"));
  assert.ok(man.count > 6000, "清单条数异常：" + man.count);
  assert.equal(man.count, man.words.length);

  const onDisk = new Set();
  for (const bucket of fs.readdirSync(path.join(ROOT, "audio/w"))) {
    const full = path.join(ROOT, "audio/w", bucket);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) if (f.endsWith(".mp3")) onDisk.add(f.slice(0, -4));
  }
  const missing = man.words.filter((w) => !onDisk.has(w));
  assert.deepEqual(missing.slice(0, 5), [], "清单里有不存在的文件");
  assert.equal(man.words.length, onDisk.size, "清单与磁盘数量不一致（改了音频要重跑 gen:manifest）");
});

test("下载只拉缺的那些（断点续传）", async () => {
  await withEnv(async (fake) => {
    const all = ["able", "tell", "ha"];
    // 假装 able 已经存过
    await fake.open().then((c) => c.put("audio/w/ab/able.mp3", {}));

    const asked = [];
    globalThis.fetch = async (u) => {
      asked.push(String(u));
      return { ok: true, status: 200 };
    };
    const r = await O.download(all, {});
    assert.deepEqual(asked.sort(), ["audio/w/ha/ha.mp3", "audio/w/te/tell.mp3"]);
    assert.equal(r.skipped, 1, "已存在的应计入 skipped 而不是重下");
    assert.equal(r.done, 2);
    assert.equal(fake.store.size, 3, "三个词都该在缓存里");
  });
});

test("单个词拉失败不中断整批", async () => {
  await withEnv(async () => {
    globalThis.fetch = async (u) => {
      if (String(u).indexOf("tell") >= 0) throw new Error("network");
      return { ok: true, status: 200 };
    };
    const r = await O.download(["able", "tell", "ha"], {});
    assert.equal(r.done, 2, "另外两个应该下成功");
    assert.equal(r.failed.length, 1, "失败的记进清单，下次续传");
  });
});

test("清除只删单词录音，整句对话音频留着", async () => {
  await withEnv(async (fake) => {
    await fake.open().then((c) =>
      Promise.all([
        c.put("audio/w/ab/able.mp3", {}),
        c.put("audio/w/te/tell.mp3", {}),
        c.put("audio/cafe/0.mp3", {}),   // 整句听写
        c.put("game.html", {}),          // 壳
      ])
    );
    const n = await O.clear();
    assert.equal(n, 2);
    assert.equal(fake.store.has("https://vq.test/audio/cafe/0.mp3"), true, "整句音频不该被删");
    assert.equal(fake.store.has("https://vq.test/game.html"), true, "页面不该被删");
  });
});

test("设备不支持缓存时明确报错，而不是假装下载成功", async () => {
  const prev = globalThis.caches;
  delete globalThis.caches;
  try {
    assert.equal(O.supported(), false);
    await assert.rejects(() => O.download(["able"], {}), /不支持/);
  } finally {
    globalThis.caches = prev;
  }
});

test("进度回调会报出总数，且不超过总数", async () => {
  await withEnv(async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    const seen = [];
    await O.download(["able", "tell", "ha"], { concurrency: 2, onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 2, "应该至少报两次（开始 + 结束）");
    const last = seen[seen.length - 1];
    assert.equal(last.total, 3);
    assert.equal(last.done, 3);
    for (const p of seen) assert.ok(p.done <= p.total, "进度超过总数：" + JSON.stringify(p));
  });
});
