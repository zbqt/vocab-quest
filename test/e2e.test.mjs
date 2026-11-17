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
const DATA_FILES = ["vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js", "grammar.js", "engine.js"];

function boot(cat = "cet4") {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/game.html?cat=" + cat,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  const doc = win.document;

  // 最小音频桩：jsdom 没有 Audio / 语音合成
  win.Audio = class {
    constructor() { this.preload = ""; this.paused = true; this.currentTime = 0; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  win.speechSynthesis = { cancel() {}, speak() {} };
  win.SpeechSynthesisUtterance = class {};
  win.confirm = () => true;

  // 必须一次性 eval：`const VOCAB_CZ` 这类顶层常量在多次 eval 之间不共享
  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE +
    "\nwindow.__t={getS:()=>S,getG:()=>G};");

  return { dom, win, doc, api: win.__t, $: (id) => doc.getElementById(id) };
}

function openFirstLevel(ctx) {
  const head = ctx.doc.querySelector(".unit-head");
  assert.ok(head, "首页应有单元列表");
  head.click();
  const play = [...ctx.doc.querySelectorAll(".level-row .btn")].find((b) => b.textContent === "闯关");
  assert.ok(play, "第一关应有「闯关」按钮");
  play.click();
  return ctx.api.getG();
}

/** 作答当前题，然后点下一题 */
function answerCurrent(ctx, correct = true) {
  const G = ctx.api.getG();
  const q = G.qs[G.idx];
  if (q.type === "spell") {
    const inp = ctx.$("spellInput");
    inp.value = correct ? q.answer : "zzz";
    [...ctx.doc.querySelectorAll("#optionsBox .btn")].find((b) => b.textContent === "提交").click();
  } else {
    const options = [...ctx.doc.querySelectorAll("#optionsBox .option")];
    const target = correct
      ? options.find((b) => b.textContent === q.answer)
      : options.find((b) => b.textContent !== q.answer);
    assert.ok(target, "应能找到可点击的选项");
    target.click();
  }
  assert.equal(ctx.api.getG().answered, true, "作答后应进入已答状态");
  const next = ctx.$("nextBtn");
  if (next && next.style.display !== "none") next.click();
  return q;
}

function playThrough(ctx, { wrongWord = false } = {}) {
  const first = openFirstLevel(ctx);
  let guard = 0, wrongedOn = null;
  while (!ctx.api.getG().finished && guard++ < 40) {
    const G = ctx.api.getG();
    const q = G.qs[G.idx];
    const makeWrong = wrongWord && !wrongedOn && q.type !== "grammar";
    if (makeWrong) wrongedOn = q.answer;
    answerCurrent(ctx, !makeWrong);
  }
  assert.ok(ctx.api.getG().finished, "应走到结算");
  return { first, wrongedOn };
}

test("完整一局（13 题全对）：3 星可达、地图写入、事件完整", () => {
  const ctx = boot("cet4");
  const G = playThrough(ctx).first;

  assert.equal(G.qs.length, 13, "12 词 + 1 语法");
  assert.equal(G.passNeed, 10, "13 题通关线 = 10");
  assert.equal(G.correct, 13);

  const s = ctx.api.getS();
  assert.equal(s.passed[1][1], 3, "第一关拿到 3 星");
  assert.equal(ctx.$("resSub").textContent, "正确 13/13 题，获得 3 星");
  assert.equal(Object.keys(s.words).length, 12, "12 个单词都进入记忆状态");
  assert.equal(s.events.filter((e) => e.type !== "session_end").length, 13, "每题一条事件");
  assert.equal(s.events.filter((e) => e.type === "session_end").length, 1);

  const c = ctx.win.VQEngine.counts(s);
  assert.equal(c.mastered, 0, "首日答对不计长期掌握");
  assert.equal(c.learning, 12);
});

test("答错一题：仍可通关，但只给 2 星，且该词进入巩固区", () => {
  const ctx = boot("cet4");
  const { wrongedOn } = playThrough(ctx, { wrongWord: true });

  const G = ctx.api.getG();
  assert.equal(G.correct, 12);
  assert.equal(G.wrong, 1);
  assert.equal(ctx.api.getS().passed[1][1], 2, "只错一题 → 2 星");

  const ws = ctx.api.getS().words[wrongedOn];
  assert.ok(ws, "错词应写入记忆状态");
  assert.equal(ws.lapses, 1);
  assert.equal(ctx.win.VQEngine.inRescue(ws), true, "进入巩固区");

  const due = ctx.win.VQEngine.dueList(ctx.api.getS(), ctx.win.VQEngine.dayKey(new Date()));
  assert.ok(due.some((x) => x.word === wrongedOn), "错词当天到期");
});

test("复习队列：只抽到期词，且包含错词；完成后今日不再开放", () => {
  const ctx = boot("cet4");
  const { wrongedOn } = playThrough(ctx, { wrongWord: true });
  ctx.$("resHome").click();

  const s = ctx.api.getS();
  const due = ctx.win.VQEngine.dueList(s, ctx.win.VQEngine.dayKey(new Date()));
  assert.equal(due.length, 1, "只有错词当天到期");
  assert.ok(ctx.$("reviewDesc").textContent.includes("错词 1 个"), "首页显示错词数");

  ctx.$("reviewBtn").click();
  const G = ctx.api.getG();
  assert.equal(G.mode, "review");
  assert.equal(G.daily, true);
  assert.equal(G.qs.length, 1, "复习题数 = 到期词数，不再随机填充");
  assert.equal(G.qs[0].answer, wrongedOn);

  answerCurrent(ctx, true);
  assert.equal(ctx.api.getS().lastReviewDate, ctx.win.VQEngine.dayKey(new Date()));
  ctx.$("resHome").click();
  assert.equal(ctx.$("reviewBtn").disabled, true, "今日复习完成后按钮关闭");
});

test("存档写入：可被重新导入并保持进度与记忆状态", () => {
  const ctx = boot("cet4");
  playThrough(ctx, { wrongWord: true });

  const raw = JSON.parse(ctx.win.localStorage.getItem("vocabQuestV2"));
  assert.equal(raw.passed[1][1], 2, "存档里是 2 星");
  assert.equal(Object.keys(raw.words).length, 12);
  assert.ok(raw.events.length >= 13);

  // 用存档自身的 passed 结构反推 units，再走一次归一化（等价于「导入」）
  const units = Object.keys(raw.passed).map((id) => ({
    id: +id,
    levels: Object.keys(raw.passed[id]).length
  }));
  const re = ctx.win.VQEngine.normalizeState(raw, { units, today: ctx.win.VQEngine.dayKey(new Date()) });
  assert.equal(re.passed[1][1], 2);
  assert.equal(Object.keys(re.words).length, 12);
  assert.equal(
    ctx.win.VQEngine.counts(re).rescue >= 1,
    true,
    "错词状态在往返后仍保留"
  );
});

test("旧版存档：首次打开自动迁移，虚高的掌握数归零", () => {
  const dom = new JSDOM(read("game.html"), {
    url: "http://localhost/game.html?cat=cet4",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  win.Audio = class { play() { return Promise.resolve(); } pause() {} };
  win.speechSynthesis = { cancel() {}, speak() {} };
  win.SpeechSynthesisUtterance = class {};

  // 构造一份旧版存档：有 masteredWords / rescue，没有 words
  const old = {
    hp: 3, lv: 7, coin: 1280, exp: 300, reviewed: 10, shufMode: false,
    mastered: 4, masteredWords: ["abandon", "ability", "able", "absent"],
    rescue: ["abnormal", "abandon"], lastReviewDate: "",
    passed: {}, passedS: {}
  };
  win.localStorage.setItem("vocabQuestV2", JSON.stringify(old));

  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE + "\nwindow.__t={getS:()=>S};");
  const s = win.__t.getS();

  assert.equal(win.VQEngine.counts(s).mastered, 0, "答对一次不再算掌握");
  assert.equal(s.words.abnormal.lapses, 1, "旧急救包转为错词状态");
  assert.equal(s.words.abnormal.dueAt, win.VQEngine.dayKey(new Date()));
  assert.equal(win.document.getElementById("ovMastered").textContent, "0/3737");
});
