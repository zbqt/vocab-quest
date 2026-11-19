/* 闯关页的「点一下立刻出声」：真实页面 + 真实 tts.js + 真实 game.html 逻辑。
 *
 * unit 测试证明的是 tts.js 单模块的行为；这一条走完整条链：
 *   进关卡 → warmAudio 把这组词解进内存 → 点喇叭 → 从内存出声（不建媒体元素）。
 * 中间任何一环没接上，离线时就是"点一下等好久"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const HTML = read("game.html");
const INLINE = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];
const DATA_FILES = ["tts.js", "offline-pack.js", "vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js", "grammar.js", "dictation.js", "zh-match.js", "fsrs.js", "engine.js", "cloud-sync.js"];

function boot() {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/game.html?cat=cet4",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  const doc = win.document;

  const started = [];
  const decoded = [];
  const ctx = {
    state: "running",
    sampleRate: 22050,
    destination: {},
    createBuffer(ch, len, rate) {
      return { numberOfChannels: ch, length: len, duration: len / (rate || 22050) };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null, connect() {}, start() { started.push(node); }, stop() {} };
      return node;
    },
    decodeAudioData(ab, ok) {
      decoded.push(ab);
      setTimeout(() => ok({ numberOfChannels: 1, length: 22050, duration: 1, sampleRate: 22050 }), 1);
    },
    resume() { ctx.state = "running"; return Promise.resolve(); }
  };
  win.AudioContext = function () { return ctx; };

  const made = [];
  win.Audio = class {
    constructor(src) { this.src = src; made.push(src); this.preload = ""; this.paused = true; this.currentTime = 0; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() {}
  };
  win.speechSynthesis = { cancel() {}, speak() {} };
  win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  win.confirm = () => true;

  const fetched = [];
  win.fetch = (u) => {
    fetched.push(String(u));
    return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4000) });
  };

  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE +
    '\nwindow.__t={getS:()=>S,getG:()=>G};');

  return { dom, win, doc, ctx, started, decoded, made, fetched, $: (id) => doc.getElementById(id) };
}

function openFirstLevel(t) {
  const head = t.doc.querySelector(".unit-head");
  assert.ok(head, "首页应有单元列表");
  head.click();
  const play = [...t.doc.querySelectorAll(".level-row .btn")].find((b) => b.textContent === "闯关");
  assert.ok(play, "第一关应有「闯关」按钮");
  play.click();
}

test("进关卡就预解码这一组的词，点喇叭直接从内存出声", async () => {
  const t = boot();
  openFirstLevel(t);

  // 解码是后台排队做的，给它几拍
  for (let i = 0; i < 40 && t.decoded.length < 10; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const G = t.win.__t.getG();
  const words = G.qs.filter((q) => q.en && /^[a-z]{2,15}$/i.test(q.en)).length;
  assert.ok(t.decoded.length >= Math.min(10, words),
    "进关卡时该把这组词解进内存，实际只解了 " + t.decoded.length + " 个（本组 " + words + " 个词）");

  // 解码取的是站内录音，不是第三方
  assert.ok(t.fetched.every((u) => u.startsWith("audio/w/")), "预解码只该取站内录音，实际：" + t.fetched.slice(0, 3));

  const before = t.made.length;
  const btn = t.$("playBtn");
  assert.ok(btn, "题目上应有播放按钮");
  btn.click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(t.started.length, 1, "点下去应该立刻 start 一个内存里的音频，而不是等媒体元素加载");
  assert.equal(t.made.length, before, "已经解好的词不该再建 <audio>（那正是离线慢的那一路）");
});
