/* 离线「点一下多久才出声」：预解码通道。
 *
 * 这组测的不是"有没有声音"，而是**声音从哪来**：
 *   走 <audio> → 每次点击都要唤醒 SW、打开缓存、读盘、建解码器、解 mp3；
 *   走内存     → start() 之后几十毫秒。
 * 两者听起来都是"能放"，区别只在离线那一下 —— 所以只能靠"有没有建媒体元素"来判断，
 * 耳朵是测不出来的。
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
const MOD = require(path.join(ROOT, "tts.js"));
const S = MOD.VQSpeech;

/* 假的 Web Audio：只记录"有没有真的开始播"，以及解码了几次 */
function fakeCtx() {
  const started = [];
  const ctx = {
    state: "running",
    sampleRate: 22050,
    destination: { __dest: true },
    decoded: 0,
    started,
    createBuffer(ch, len, rate) {
      return { numberOfChannels: ch, length: len, duration: len / (rate || 22050), sampleRate: rate };
    },
    createBufferSource() {
      const node = {
        buffer: null, onended: null, stopped: false,
        connect(t) { node.dest = t; },
        start() { node.began = true; started.push(node); },
        stop() { node.stopped = true; }
      };
      return node;
    },
    decodeAudioData(ab, ok) {
      ctx.decoded++;
      // 真实实现是异步的：这里也异步，才能暴露"没等解码就播"这类问题
      setTimeout(() => ok({ numberOfChannels: 1, length: 22050, duration: 1, sampleRate: 22050 }), 1);
    },
    resume() { ctx.state = "running"; return Promise.resolve(); }
  };
  return ctx;
}

/* 整个文件共用同一个 AudioContext：tts.js 内部把它记在闭包里（真实浏览器里也只该有一个，
 * 多了 iOS 会限制）。所以每个用例只重置计数，不换对象。 */
const CTX = fakeCtx();

function withEnv(opts, fn) {
  const prev = {
    AudioContext: MOD.AudioContext,
    Audio: MOD.Audio,
    fetch: MOD.fetch,
    navigator: MOD.navigator,
    speechSynthesis: MOD.speechSynthesis,
    SpeechSynthesisUtterance: MOD.SpeechSynthesisUtterance
  };
  const ctx = CTX;
  ctx.started.length = 0;
  ctx.decoded = 0;
  const fetched = [];
  const made = [];

  MOD.AudioContext = function () { return ctx; };
  MOD.Audio = class {
    constructor(src) { this.src = src; made.push(src); this.readyState = 0; }
    play() { return Promise.reject(new Error("不该走到这里")); }
    pause() {} load() {} removeAttribute() {}
  };
  MOD.navigator = { onLine: opts.offline !== true };
  MOD.fetch = (u) => {
    fetched.push(String(u));
    return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4500) });
  };
  MOD.speechSynthesis = null;
  MOD.SpeechSynthesisUtterance = undefined;

  return Promise.resolve()
    .then(() => fn({ ctx, fetched, made }))
    .finally(() => Object.assign(MOD, prev));
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("预解码之后：点播放不再建媒体元素，直接从内存出声", () =>
  withEnv({}, async ({ ctx, fetched, made }) => {
    S.setVoice("us");
    const n = S.preloadWords(["able"]);
    assert.equal(n, 1, "应该排进解码队列");
    await tick(30);

    assert.equal(fetched.length, 1, "一个词只该取一次文件");
    assert.equal(ctx.decoded, 1, "应该解码了一次");

    let ok = null;
    S.speak("able", { onDone: (done) => { ok = done; } });
    await tick(20);

    assert.deepEqual(made, [], "已经解好的词不该再建 <audio>：那正是离线慢的那一路");
    assert.equal(ctx.started.length, 1, "应该真的 start 了一个 AudioBufferSourceNode");

    // 播完要能收尾，否则按钮永远停在「播放中」
    ctx.started[0].onended();
    await tick(5);
    assert.equal(ok, true, "播完要回调成功");
  }));

test("同一组词只解一次：重复预载不会重复取文件", () =>
  withEnv({}, async ({ fetched }) => {
    S.preloadWords(["tell", "tell", "tell"]);
    await tick(30);
    S.preloadWords(["tell"]);
    await tick(20);
    assert.equal(fetched.length, 1, "同一个词取了两遍，等于白等两轮");
  }));

test("离线也照样从内存出声：这条路根本不碰网络", () =>
  withEnv({ offline: true }, async ({ ctx, made }) => {
    S.preloadWords(["abandon"]);
    await tick(30);
    S.speak("abandon", {});
    await tick(20);
    assert.deepEqual(made, [], "离线时更不该退到 <audio>");
    assert.equal(ctx.started.length, 1);
  }));

test("没预解码过：退回 <audio>，但顺手补一次解码，下一次就是秒出", () =>
  withEnv({}, async ({ ctx, fetched }) => {
    S.speak("banana", {});          // 没预载，第一次只能走媒体元素
    await tick(30);
    assert.deepEqual(fetched, ["audio/w/ba/banana.mp3"], "走 <audio> 的同时应该开始补解码");
    assert.equal(ctx.decoded, 1);
  }));

test("内存有上限：解码太多之后，最早的词退化为走媒体元素（而不是无限吃内存）", () =>
  withEnv({}, async ({ ctx, made }) => {
    // 必须是「2~15 个纯小写字母」才落得到站内文件（localSrc 的规则）
    const list = [];
    for (let i = 0; i < 90; i++) {
      list.push("zz" + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
    }
    S.preloadWords(list);
    // 解码是 3 路并发的，90 个要跑一阵
    for (let i = 0; i < 200 && ctx.decoded < 90; i++) await tick(5);
    assert.equal(ctx.decoded, 90, "应该全解完了");

    S.speak(list[0], {});           // 最早的已经被淘汰
    await tick(20);
    // 退到媒体元素，第一路仍然是站内录音：淘汰只影响"快不快"，不影响"能不能听"
    assert.equal(made[0], S.localSrc(list[0]), "被淘汰的词要能退回媒体元素，不能变成哑的");

    S.speak(list[88], {});          // 刚解完的还在
    await tick(20);
    assert.equal(made.filter((u) => u === S.localSrc(list[88])).length, 0, "最近的词仍该走内存");
  }));
