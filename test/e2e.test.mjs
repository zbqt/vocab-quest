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
const DATA_FILES = ["tts.js", "vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js", "grammar.js", "fsrs.js", "engine.js", "cloud-sync.js"];

function boot(cat = "cet4", opts = {}) {
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
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  win.confirm = () => true;

  // 必须一次性 eval：`const VOCAB_CZ` 这类顶层常量在多次 eval 之间不共享
  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE +
    "\nwindow.__t={getS:()=>S,getG:()=>G,getP:()=>P,cfg:CFG};");

  // 这些用例考的是"系统合成"通道的细节，先锁定到 native，别被默认的录音通道带跑
  if (opts.voice) win.VQSpeech.setVoice(opts.voice);

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

test("今日队列：错词排在最前，新词按学习顺序补齐", () => {
  const ctx = boot("cet4");
  const { wrongedOn } = playThrough(ctx, { wrongWord: true });
  ctx.$("resHome").click();

  const s = ctx.api.getS();
  const due = ctx.win.VQEngine.dueList(s, ctx.win.VQEngine.dayKey(new Date()));
  assert.equal(due.length, 1, "只有错词当天到期");
  assert.ok(ctx.$("heroSub").textContent.includes("复习 1"), "首页写明今天有几个复习");

  ctx.$("heroBtn").click();
  const G = ctx.api.getG();
  assert.equal(G.mode, "review");
  assert.equal(G.daily, true);
  assert.equal(G.qs[0].answer, wrongedOn, "第一题就是刚错的词");
  assert.equal(G.qs.length, 16, "1 个复习 + 15 个新词（新词上限 15）");

  // 还没答对过的词（包括刚错的）只考认词，答对过才考拼写
  const byWord = {};
  G.qs.forEach((q) => { if (q.en) byWord[q.en] = q.type; });
  assert.equal(byWord[wrongedOn], "match", "刚答错还没答对过，第二次仍只考认词");

  // 答对一次之后，同一个词就该考拼写了（先把它的到期日拨回今天）
  const day = ctx.win.VQEngine.dayKey(new Date());
  ctx.win.VQEngine.recordAnswer(s, { word: wrongedOn, type: "match", correct: true, today: day });
  s.words[wrongedOn].dueAt = day;
  ctx.$("resHome").click();
  ctx.$("heroBtn").click();
  const G2 = ctx.api.getG();
  const q2 = G2.qs.find((q) => q.en === wrongedOn);
  assert.ok(q2, "答对过的词应再次出现在队列里");
  assert.equal(q2.type, "spell", "答对过一次 → 改考拼写");
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
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

  // 构造一份旧版存档：有 masteredWords / rescue，没有 words
  const old = {
    hp: 3, lv: 7, coin: 1280, exp: 300, reviewed: 10, shufMode: false,
    mastered: 4, masteredWords: ["abandon", "ability", "able", "absent"],
    rescue: ["abnormal", "abandon"], lastReviewDate: "",
    passed: {}, passedS: {}
  };
  win.localStorage.setItem("vocabQuestV2", JSON.stringify(old));

  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE + "\nwindow.__t={getS:()=>S,getP:()=>P};");
  const s = win.__t.getS();

  assert.equal(win.VQEngine.counts(s).mastered, 0, "答对一次不再算掌握");
  assert.equal(s.words.abnormal.lapses, 1, "旧急救包转为错词状态");
  assert.equal(s.words.abnormal.dueAt, win.VQEngine.dayKey(new Date()));
  assert.equal(win.document.getElementById("ovMastered").textContent, "0");
});

/* ================= P1：定级测试 ================= */

/** 把定级测试答完：correctFor(band) 决定该层答对还是答错 */
function runPlacement(ctx, correctFor) {
  ctx.$("placeBtn").click();
  let guard = 0;
  while (ctx.api.getP() && guard++ < 80) {
    const P = ctx.api.getP();
    const q = P.qs[P.idx];
    if (!q) break;
    const want = correctFor(q.band);
    const options = [...ctx.doc.querySelectorAll("#placeOptions .option")];
    const target = want
      ? options.find((b) => b.textContent === q.answer)
      : options.find((b) => b.textContent !== q.answer);
    assert.ok(target, "定级选项应可点击");
    target.click();
    ctx.$("placeNext").click();
  }
  assert.ok(guard < 80, "定级应当结束");
}

test("定级：42 题全对 → 估算接近满库，答对的词被跳过", () => {
  const ctx = boot("cet4");
  runPlacement(ctx, () => true);

  const s = ctx.api.getS();
  const size = s.placement.estimate;
  assert.ok(s.placement, "定级结果已写入存档");
  assert.ok(size >= 3000, "全对时估算应接近四级全库，实际 " + size);
  assert.equal(s.placement.skipped, 42, "42 道答对的词全部标记跳过");

  const placed = Object.keys(s.words).filter((w) => s.words[w].placed);
  assert.equal(placed.length, 42);
  const day0 = ctx.win.VQEngine.dayKey(new Date());
  assert.equal(s.words[placed[0]].dueAt, ctx.win.VQEngine.addDays(day0, 60), "60 天后抽查");

  // 定级测过的词不应再作为新词发放
  const q = ctx.win.VQEngine.dailyQueue(s, {
    today: day0, total: 20, newMax: 10, newFloor: 10,
    order: ctx.win.VQEngine.learnOrder(ctx.win.VQBANK || [], s.placement)
  });
  assert.ok(placed.every((w) => !q.words.some((x) => x.word === w)), "跳过的词不再发放");
});

test("定级：结果页显示估算与分段掌握率，并可按分段重排学习顺序", () => {
  const ctx = boot("cet4");
  runPlacement(ctx, (band) => band <= 2);   // 前两段会，后面不会

  const s = ctx.api.getS();
  assert.equal(ctx.$("placeResultBox").style.display, "block");
  assert.ok(ctx.$("prEstimate").textContent.length > 0);
  assert.ok(ctx.$("prBands").innerHTML.includes("第 6 段"), "六段都列出");

  const bands = s.placement.bands;
  assert.equal(bands.length, 6);
  assert.ok(bands[0].trueRate > 0.9, "第 1 段全对");
  assert.equal(bands[5].trueRate, 0, "第 6 段全错");
  assert.ok(s.placement.estimate > 0 && s.placement.estimate < 3737, "估算落在中间区间");

  // 会的那两段（第 1、2 段）应该排在最后学
  const bank = []; for (let i = 0; i < 600; i++) bank.push("w" + i);
  const order = ctx.win.VQEngine.learnOrder(bank, s.placement);
  const lastTwoBands = order.slice(-200).map((x) => +x.slice(1));
  assert.ok(lastTwoBands.every((i) => i < 200), "掌握最好的前两段排在最后，实际 " + order.slice(-3));
  const firstBand = +order[0].slice(1);
  assert.ok(firstBand >= 200, "先学的是不熟的段，实际 " + order[0]);
});

test("「这词我会」按钮：跳过当前题、推到 60 天后、结算如实报数", () => {
  const ctx = boot("cet4");
  ctx.$("heroBtn").click();

  const G = ctx.api.getG();
  const firstWord = G.qs[0].answer;
  assert.equal(ctx.$("knownBtn").style.display, "block", "单词题显示跳过按钮");

  ctx.$("knownBtn").click();
  const after = ctx.api.getG();
  assert.equal(after.idx, 1, "跳过直接进入下一题");
  assert.equal(after.skipped, 1);

  const ws = ctx.api.getS().words[firstWord];
  assert.equal(ws.placed, true);
  const day = ctx.win.VQEngine.dayKey(new Date());
  assert.equal(ws.dueAt, ctx.win.VQEngine.addDays(day, 60));

  // 把剩下的题都跳过，看结算怎么说
  let guard = 0;
  while (!ctx.api.getG().finished && guard++ < 40) ctx.$("knownBtn").click();
  assert.ok(ctx.api.getG().finished, "跳完也会结算");
  assert.ok(ctx.$("resSub").textContent.includes("正确 0/"), "跳过不算答对：" + ctx.$("resSub").textContent);
  assert.ok(ctx.$("resSub").textContent.includes("跳过"), "结算如实报出跳过数");
  assert.equal(ctx.$("resTitle").textContent, "今天的学习完成");
});

test("默认优先真人录音：能放录音就不碰系统合成", () => {
  const ctx = boot("cet4");
  const urls = [];
  let spoken = 0;
  ctx.win.Audio = class {
    constructor(u) { urls.push(u); }
    play() { if (this.onplaying) this.onplaying(); if (this.onended) this.onended(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {}, getVoices() { return []; }, speak() { spoken++; }
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");
  assert.equal(urls.length, 1, "默认应放词典录音");
  assert.ok(/type=2/.test(urls[0]), "默认美音（type=2）：" + urls[0]);
  assert.equal(spoken, 0, "录音能放就不该调系统合成（手机自带的英文合成音很机械）");
});

test("选「系统合成」时走原生 TTS：零外链、不创建 Audio、读完按钮复位", () => {
  // 静态检查：不许再有发音接口外链；实际会被加载的 src/href 必须是相对路径
  // （og:image 这类 meta content 只是分享卡片预览，不算页面加载的资源）
  for (const f of ["game.html", "words.html", "index.html"]) {
    const src = read(f);
    assert.ok(!/dict\.youdao\.com|dictvoice/.test(src), f + " 不应再引用有道发音接口");
    const refs = [...src.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const r of refs) {
      assert.ok(!/^(https?:)?\/\//i.test(r), f + " 不应加载外部资源：" + r);
    }
  }

  const ctx = boot("cet4", { voice: "native" });
  let audioMade = 0, spoken = [];
  ctx.win.Audio = class { constructor() { audioMade++; } play() { return Promise.resolve(); } pause() {} };
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {},
    getVoices() { return []; },
    speak(u) { spoken.push(u); if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
  };

  ctx.win.showAudio("abandon", "ə'bændən");
  assert.equal(ctx.$("phonetic").textContent, "/ə'bændən/");
  ctx.win.playWord("abandon");

  assert.equal(audioMade, 0, "不应创建 Audio 去拉远程音频");
  assert.equal(spoken.length, 1, "应调用一次语音合成");
  assert.equal(spoken[0].lang, "en-US");
  assert.equal(spoken[0].rate, 0.8, "合成语速比正常慢一点（0.8）；录音则按原速，不快进也不拉伸");
  assert.equal(ctx.$("playBtn").textContent, "🔊 重新播放", "读完按钮回到可重播状态");
  assert.equal(ctx.$("playBtn").disabled, false);
  assert.equal(ctx.$("audioStatus").textContent, "");
});

test("没有语音引擎的浏览器：自动改用在线发音，按钮能正常复位", () => {
  const ctx = boot("cet4");
  delete ctx.win.speechSynthesis;
  delete ctx.win.SpeechSynthesisUtterance;
  const urls = [];
  const made = [];
  ctx.win.Audio = class {
    constructor(u) { this.src = u; urls.push(u); made.push(this); }
    play() { if (this.onplaying) this.onplaying(); if (this.onended) this.onended(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  ctx.win.showAudio("abandon", "");
  assert.doesNotThrow(() => ctx.win.playWord("abandon"), "拿不到原生朗读也不能抛错");
  assert.equal(urls.length, 1, "应改走在线音频，而不是干巴巴报不支持");
  assert.ok(/youdao/.test(urls[0]) && /abandon/.test(urls[0]), "音频地址要带上被点的词：" + urls[0]);
  assert.equal(made[0].playbackRate, 1, "录音按原速播：时间拉伸会让短单词发金属味");
  assert.equal(ctx.$("playBtn").textContent, "🔊 重新播放", "播放成功后按钮回到可重播状态");
  assert.equal(ctx.$("playBtn").disabled, false);
});

test("原生朗读失败时自动转在线发音，不让用户看到一句报错就结束", () => {
  const ctx = boot("cet4", { voice: "native" });
  const urls = [];
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    getVoices() { return []; },
    cancel() {},
    speak() { throw new Error("engine boom"); }
  };
  ctx.win.Audio = class {
    constructor(u) { urls.push(u); }
    play() { if (this.onplaying) this.onplaying(); if (this.onended) this.onended(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  ctx.win.showAudio("abandon", "");
  assert.doesNotThrow(() => ctx.win.playWord("abandon"), "原生引擎抛异常也不能崩");
  assert.equal(urls.length, 1, "原生引擎炸了要兜到在线音频");
  assert.equal(ctx.$("playBtn").textContent, "🔊 重新播放");
});

test("在线发音也失败：给出可读原因并允许重试，不卡在「播放中」", async () => {
  const ctx = boot("cet4");
  delete ctx.win.speechSynthesis;
  delete ctx.win.SpeechSynthesisUtterance;
  ctx.win.Audio = class {
    constructor() {}
    play() { const e = new Error("no"); e.name = "NotSupportedError"; return Promise.reject(e); }
    pause() {} removeAttribute() {} load() {}
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx.$("playBtn").textContent, "🔊 重试");
  assert.ok(ctx.$("audioStatus").textContent.includes("在线发音"), "要说明是「在线发音」没加载成功：" + ctx.$("audioStatus").textContent);
  assert.equal(ctx.$("playBtn").disabled, false);
});

test("正在朗读时点下一个词：先 cancel 再重发，新词不会被吞掉", async () => {
  const ctx = boot("cet4", { voice: "native" });
  const spoken = [], calls = [];
  let speaking = false;
  ctx.win.speechSynthesis = {
    get speaking() { return speaking; },
    pending: false,
    paused: false,
    getVoices() { return []; },
    cancel() { calls.push("cancel"); speaking = false; },
    speak(u) { calls.push("speak"); spoken.push(u.text); speaking = true; }
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");
  assert.deepEqual(spoken, ["abandon"], "空闲时第一次直接发声");

  ctx.win.playWord("ability"); // 还在读的时候点第二个词
  assert.equal(calls[calls.length - 1], "cancel", "应先取消上一次");

  await new Promise((r) => setTimeout(r, 30)); // cancel 是异步的，要让出一轮事件循环
  assert.deepEqual(spoken, ["abandon", "ability"], "取消后新词仍要发声");
  assert.ok(calls.lastIndexOf("cancel") < calls.lastIndexOf("speak"), "顺序必须是 cancel → speak");
});

test("有多个音色时优先选 en-US 本地音色", () => {
  const ctx = boot("cet4", { voice: "native" });
  const picked = [];
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {},
    getVoices() {
      return [
        { name: "Ting-Ting", lang: "zh-CN", localService: true },
        { name: "Daniel", lang: "en-GB", localService: true },
        { name: "Samantha", lang: "en-US", localService: true },
        { name: "Google US English", lang: "en_US", localService: false }
      ];
    },
    speak(u) { picked.push(u); if (u.onstart) u.onstart(); if (u.onend) u.onend(); }
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");

  assert.equal(picked.length, 1);
  assert.ok(picked[0].voice, "应显式指定 voice，安卓上不指定常静默失败");
  assert.equal(picked[0].voice.name, "Samantha", "应选中本地 en-US 音色");
  assert.equal(picked[0].lang, "en-US");
});

test("引擎不派发 onstart 但在真的说话：不重试、不会播两遍", async () => {
  const ctx = boot("cet4", { voice: "native" });
  const spoken = [];
  let speaking = false;
  ctx.win.speechSynthesis = {
    get speaking() { return speaking; },
    pending: false,
    paused: false,
    cancel() { speaking = false; },
    getVoices() { return []; },
    speak(u) { spoken.push(u.text); speaking = true; } // 故意不调 onstart
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");

  await new Promise((r) => setTimeout(r, 700)); // 越过 600ms 的 watchdog
  assert.deepEqual(spoken, ["abandon"], "已经在说话就不该重试");
});

test("合成被浏览器拦截（not-allowed）时给出可操作提示", () => {
  const ctx = boot("cet4", { voice: "native" });
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {},
    getVoices() { return []; },
    speak(u) { if (u.onerror) u.onerror({ error: "not-allowed" }); }
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon");
  assert.equal(ctx.$("playBtn").textContent, "🔊 重试");
  assert.ok(ctx.$("audioStatus").textContent.includes("点一下页面"), "要告诉用户怎么解开手势限制：" + ctx.$("audioStatus").textContent);
});

test("答题后的自动朗读被拦时不打扰用户，喇叭仍可点", () => {
  const ctx = boot("cet4", { voice: "native" });
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {},
    getVoices() { return []; },
    speak(u) { if (u.onerror) u.onerror({ error: "not-allowed" }); }
  };
  ctx.win.showAudio("abandon", "");
  ctx.win.playWord("abandon", { auto: true });
  assert.equal(ctx.$("playBtn").textContent, "🔊 播放发音", "自动朗读失败应静默复位");
  assert.equal(ctx.$("audioStatus").textContent, "", "不该在答题后弹错误");
  assert.equal(ctx.$("playBtn").disabled, false);
});

/* ================= 本轮优化：首屏减重 / 语法防重 / 错词重练 ================= */

test("首页统计来自 stats.js，且与四个词库完全一致", () => {
  const stats = new Function(read("stats.js") + ";return VQ_STATS;")();
  const books = { cz: "vocab_cz.js", gz: "vocab_gz.js", cet4: "vocab.js", c6: "vocab_c6.js" };
  let total = 0;
  const uniq = new Set();
  for (const [k, f] of Object.entries(books)) {
    const src = read(f);
    const name = src.match(/(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=/)[1];
    const data = new Function(src + `;return ${name};`)();
    const n = data.reduce((s, u) => s + u.words.length, 0);
    assert.equal(stats.books[k], n, k + " 词条数与 stats.js 不一致，请重跑 npm run gen:stats");
    total += n;
    data.forEach((u) => u.words.forEach((w) => uniq.add(String(w[0]).toLowerCase().trim())));
  }
  assert.equal(stats.total, total);
  assert.equal(stats.uniq, uniq.size, "去重数与 stats.js 不一致");
  assert.equal(stats.phonetic, total, "有词条缺音标");
});

test("首页不再下载完整词库（716KB → 一个统计文件）", () => {
  const html = read("index.html");
  for (const f of ["vocab.js", "vocab_c6.js", "vocab_cz.js", "vocab_gz.js"]) {
    assert.ok(!html.includes(f), "首页不该再引用 " + f);
  }
  assert.ok(html.includes('src="stats.js"'), "首页应只读 stats.js");
});

test("语法题库：答案必须在选项里，且每级不少于 30 道", () => {
  const src = read("grammar.js");
  const G = new Function(src + ";return GRAMMAR;")();
  for (const k of Object.keys(G)) {
    assert.ok(G[k].length >= 30, k + " 语法题不足 30 道，练几关就会撞原题");
    for (const q of G[k]) {
      assert.ok(q.options.includes(q.a), `${k}: 答案不在选项里 → ${q.q}`);
      assert.equal(new Set(q.options).size, 4, `${k}: 选项应互不相同 → ${q.q}`);
      assert.ok(q.tip && q.tip.length > 3, `${k}: 缺少解析 → ${q.q}`);
    }
    const prompts = new Set(G[k].map((q) => q.q));
    assert.equal(prompts.size, G[k].length, k + " 有重复题干");
  }
});

test("语法题优先出没做过的：做过的题排在后面", () => {
  const ctx = boot("cet4");
  const S = ctx.api.getS();
  const all = ctx.api.cfg.grammar;   // const 声明不会挂到 window 上，从 __t 取
  assert.ok(all.length >= 30);

  // 标记除最后 3 题外全部做过
  S.gSeen = {};
  all.slice(0, all.length - 3).forEach((g, i) => { S.gSeen[g.q] = 1000 + i; });

  const picked = ctx.win.grammarPick(3).map((g) => g.q);
  const freshSet = new Set(all.slice(-3).map((g) => g.q));
  assert.equal(picked.length, 3);
  picked.forEach((q) => assert.ok(freshSet.has(q), "应优先挑没做过的题，实际挑到：" + q));

  // 全做完之后仍能出题（按最久没做的补），不会变成空白
  all.forEach((g, i) => { S.gSeen[g.q] = 5000 + i; });
  const again = ctx.win.grammarPick(3).map((g) => g.q);
  assert.deepEqual(again.sort(), all.slice(0, 3).map((g) => g.q).sort(), "应挑最久没做的三题");
});

test("错词重练：没有错词时不出现，有错词后可一键开练", () => {
  const ctx = boot("cet4");
  assert.equal(ctx.$("rescueCard").style.display, "none", "没错词时不该占位置");

  const S = ctx.api.getS();
  ctx.win.VQEngine.recordAnswer(S, { word: "abandon", type: "match", correct: false, today: "2026-11-17" });
  ctx.win.renderHome();
  assert.equal(ctx.$("rescueCard").style.display, "flex", "有错词时应出现重练卡片");
  assert.match(ctx.$("rescueBtn").textContent, /练 \d+ 词/);

  ctx.$("rescueBtn").click();
  const G = ctx.api.getG();
  assert.equal(G.rescue, true, "应进入错词重练模式");
  assert.equal(G.mode, "review", "错词重练不扣体力、不计星");
  assert.ok(G.qs.length >= 1);
  assert.equal(ctx.$("modeTag").textContent, "错词重练");
  assert.ok(ctx.$("gameView").classList.contains("active"));
});

test("近 7 天：7 根柱、今天在最右，数据来自本地事件日志", () => {
  const ctx = boot("cet4");
  const S = ctx.api.getS();
  S.events.length = 0;
  const push = (dayAgo, n) => {
    const d = new Date();
    d.setDate(d.getDate() - dayAgo);
    for (let i = 0; i < n; i++) S.events.push({ ts: d.getTime(), type: "match", word: "abandon", correct: i % 2 === 0 ? 1 : 0 });
  };
  push(0, 6);
  push(2, 4);
  ctx.win.renderHome();

  const bars = ctx.doc.querySelectorAll("#weekBars .wb");
  assert.equal(bars.length, 7, "应固定画 7 天");
  assert.ok(bars[6].classList.contains("wb-today"), "最右一格是今天");
  assert.match(ctx.$("weekMeta").textContent, /10 题/);
  assert.match(ctx.$("weekMeta").textContent, /正确率 50%/, "6 题对 3、4 题对 2 → 5/10");
  assert.match(ctx.$("weekMeta").textContent, /2 天有学/);
});

test("没有任何记录时，周视图给一句人话而不是空白", () => {
  const ctx = boot("cet4");
  ctx.api.getS().events.length = 0;
  ctx.win.renderHome();
  assert.equal(ctx.$("weekMeta").textContent, "最近 7 天还没有记录");
  assert.equal(ctx.doc.querySelectorAll("#weekBars .wb").length, 7);
});

test("键盘：数字键选选项、回车进下一题、已答后数字键不重复作答", () => {
  const ctx = boot("cet4");
  const G = openFirstLevel(ctx);
  assert.equal(G.qs[G.idx].type, "match", "第一题应是认词四选一");
  const fire = (key) => ctx.doc.dispatchEvent(new ctx.win.KeyboardEvent("keydown", { key, bubbles: true }));

  fire("2");
  assert.equal(ctx.api.getG().answered, true, "按数字键应直接作答");
  const afterFirst = ctx.api.getG();
  assert.equal(afterFirst.idx, 0, "作答后先停在本题，等用户看解析");

  fire("3"); // 已答状态下再按数字键，不应改判
  assert.equal(ctx.api.getG().idx, 0);
  assert.equal(ctx.api.getG().correct + ctx.api.getG().wrong, afterFirst.correct + afterFirst.wrong);

  fire("Enter");
  assert.equal(ctx.api.getG().idx, 1, "回车应进入下一题");
});

test("周视图：点「这词我会」的跳过算题数，但不拉低正确率", () => {
  const ctx = boot("cet4");
  const S = ctx.api.getS();
  S.events.length = 0;
  const now = Date.now();
  S.events.push({ ts: now, type: "match", word: "abandon", correct: 1 });
  S.events.push({ ts: now, type: "match", word: "ability", correct: 0 });
  S.events.push({ ts: now, type: "skip", word: "able" });
  ctx.win.renderHome();
  const meta = ctx.$("weekMeta").textContent;
  assert.match(meta, /3 题/, "跳过也进题数");
  assert.match(meta, /正确率 50%/, "只在真答的两题里算：1/2");
});

test("换发音风格：美音↔英音↔系统合成，选择会被记住", () => {
  const ctx = boot("cet4");
  const urls = [];
  ctx.win.Audio = class {
    constructor(u) { urls.push(u); }
    play() { if (this.onplaying) this.onplaying(); if (this.onended) this.onended(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  assert.equal(ctx.win.VQSpeech.voice, "us", "默认美音");
  ctx.win.showAudio("abandon", "");

  ctx.win.VQSpeech.setVoice("uk");
  ctx.win.playWord("abandon");
  assert.ok(/type=1/.test(urls[urls.length - 1]), "选英音后应取 type=1：" + urls[urls.length - 1]);
  assert.equal(ctx.win.localStorage.getItem("vq_voice_pref"), "uk", "选择要落到 localStorage");

  ctx.win.VQSpeech.setVoice("native");
  assert.equal(ctx.win.VQSpeech.voiceName, "系统合成");
  assert.equal(ctx.win.VQSpeech.nextVoice(), "us", "循环切换要能绕回来");
});

test("预取：题目出现时先把录音下下来，但不发声", () => {
  const ctx = boot("cet4");
  const made = [];
  ctx.win.Audio = class {
    constructor(u) { this.src = u; this.played = false; made.push(this); }
    play() { this.played = true; return Promise.resolve(); }
    pause() {} removeAttribute() {} load() { this.loaded = true; }
  };
  ctx.win.VQSpeech.prefetch("abandon");
  assert.equal(made.length, 1, "应预取一条录音");
  assert.ok(/abandon/.test(made[0].src));
  assert.equal(made[0].played, false, "预取只下载不播放");
  assert.equal(made[0].loaded, true, "要真正触发下载");
});

/* ================= 听音选词 ================= */

const LISTEN_Q = {
  type: "listen", en: "abandon", zh: "放弃", ph: "əˈbændən", prompt: "",
  answer: "abandon",
  options: ["abandon", "ability", "absorb", "abstract"],
  optDefs: [
    { en: "abandon", zh: "放弃", ph: "əˈbændən" },
    { en: "ability", zh: "能力", ph: "əˈbɪləti" },
    { en: "absorb", zh: "吸收", ph: "əbˈsɔːb" },
    { en: "abstract", zh: "抽象的", ph: "ˈæbstrækt" }
  ]
};

function plantListen(ctx) {
  const G = openFirstLevel(ctx);
  G.qs[G.idx] = Object.assign({}, LISTEN_Q, { options: LISTEN_Q.options.slice(), optDefs: LISTEN_Q.optDefs.slice() });
  ctx.win.renderQ();
  return G;
}

test("听音题答题前：不露英文、不露音标，只给一个扬声器", () => {
  const ctx = boot("cet4");
  plantListen(ctx);
  assert.match(ctx.$("enemyLabel").textContent, /听音/, "题型标签要标明是听音题");
  assert.match(ctx.$("cnWord").textContent, /听发音/, "题干只说明要听，不给词");
  assert.ok(!ctx.$("cnWord").textContent.includes("abandon"), "题干绝不能把答案写出来");
  assert.equal(ctx.$("phonetic").textContent, "", "音标基本等于答案，答题前不能显示");
  assert.equal(ctx.$("audioRow").style.display, "flex", "必须给出播放按钮，否则没法听");
  assert.equal(ctx.doc.querySelectorAll("#optionsBox .option").length, 4, "四个英文单词选项");
});

test("听音题：设备放不出声音时当场降级，不会留下一道无法作答的死题", async () => {
  const ctx = boot("cet4");
  delete ctx.win.Audio;
  delete ctx.win.speechSynthesis;
  delete ctx.win.SpeechSynthesisUtterance;
  const G = plantListen(ctx);

  await new Promise((r) => setTimeout(r, 400)); // 等自动试播失败

  const q = G.qs[G.idx];
  assert.equal(q.type, "match", "放不出声就必须退化成认词题");
  assert.equal(ctx.$("cnWord").textContent, "放弃", "降级后靠中文题干作答");
  assert.match(ctx.$("qTitle").textContent, /改成看中文/, "要跟用户说明白为什么变样了");
  assert.match(ctx.$("audioStatus").textContent, /未计入/, "没出声就不算听过，必须明说");

  const opt = [...ctx.doc.querySelectorAll("#optionsBox .option")].find((b) => b.textContent === "abandon");
  opt.click();
  assert.equal(G.answered, true, "降级后必须能正常作答");
});

test("听音题答完后把词亮出来：音标和释义都还给用户", () => {
  const ctx = boot("cet4");
  const G = plantListen(ctx);
  const opt = [...ctx.doc.querySelectorAll("#optionsBox .option")].find((b) => b.textContent === "abandon");
  opt.click();
  assert.equal(G.correct, 1, "选对要算对");
  assert.equal(ctx.$("phonetic").textContent, "/əˈbændən/", "答完该把音标补上，这是学习反馈的一部分");
  assert.ok(ctx.$("optDefs").textContent.includes("放弃"), "四个词的中文释义都要摊开给看");
});

test("闯关里真的会出现听音题，不是只在测试里存在", () => {
  const ctx = boot("cet4");
  const G = openFirstLevel(ctx);
  const kinds = {};
  G.qs.forEach((q) => { kinds[q.type] = (kinds[q.type] || 0) + 1; });
  assert.ok(kinds.listen > 0, "12 个词的关卡里应该至少有一道听音题，实际：" + JSON.stringify(kinds));
});

test("每日队列：有复习词时才穿插听音题，新词永远只考认词", () => {
  const ctx = boot("cet4");
  const S = ctx.api.getS();
  // 造三个「已经答对过、今天该复习」的词
  ["abandon", "ability", "able"].forEach((w) => {
    S.words[w] = {
      seen: 3, reps: 3, stability: 2, difficulty: 5,
      dueAt: "2000-01-01", lastReview: "2000-01-01",
      okDays: ["2000-01-01", "2000-01-02", "2000-01-03"],
      lapses: 0, dirs: { recog: "2000-01-03" }
    };
  });
  ctx.$("heroBtn").click();
  const G = ctx.api.getG();
  const byType = {};
  G.qs.forEach((q, i) => {
    byType[q.type] = (byType[q.type] || 0) + 1;
    if (q.type === "listen") assert.ok(q.options && q.options.length === 4, "听音题必须有四个选项");
  });
  assert.ok(byType.listen > 0, "有复习词时应该出现听音题，实际：" + JSON.stringify(byType));
  assert.ok(byType.match > 0, "新词仍然只考认词");
  assert.ok(!G.qs.some((q) => q.type === "grammar"), "每日队列只练词，不插语法题");
});

test("隐藏发音行时要把音标一起清掉，不能留着上一题的", () => {
  const ctx = boot("cet4");
  const G = openFirstLevel(ctx);
  // 找一道不带发音行的认词题
  const mi = G.qs.findIndex((q) => q.type === "match");
  assert.ok(mi >= 0, "应存在认词题");
  ctx.$("phonetic").textContent = "/残留值/";
  G.idx = mi;
  ctx.win.renderQ();
  assert.equal(ctx.$("phonetic").textContent, "", "认词题不该在 DOM 里留着音标");
});

/* ================= 听力专练（听音选义） ================= */

test("听力专练：一个词都没学过时是锁着的，不会拿生词让人瞎蒙", () => {
  const ctx = boot("cet4");
  const head = ctx.doc.querySelector(".unit-head");
  head.click();
  const row = ctx.doc.querySelector(".listen-row");
  assert.ok(row, "每个单元下面都该有一行听力专练");
  assert.ok(row.textContent.includes("学过的词还不够"), "没学词时应该提示先闯关");
  assert.ok(![...row.querySelectorAll(".btn")].some((b) => b.textContent === "开始"), "锁着时不该有开始按钮");
});

test("听力专练：学完一关后开练，整局全是听音选义、答完记 3 星", () => {
  const ctx = boot("cet4");
  playThrough(ctx);            // 第一关 12 个词全见过
  ctx.$("resHome").click();    // 回地图重渲染

  const row = ctx.doc.querySelector(".listen-row");
  const startBtn = [...row.querySelectorAll(".btn")].find((b) => b.textContent === "开始");
  assert.ok(startBtn, "学过 12 个词后应该能开练");
  startBtn.click();

  const G = ctx.api.getG();
  assert.equal(G.listen, true, "要标记成听力专练局");
  assert.equal(G.hp, 999, "听力关不扣体力：放不出声连错也不该被打死");
  assert.ok(G.qs.length >= 4);
  G.qs.forEach((q) => {
    assert.equal(q.type, "listenZh", "听力关只出听音选义：" + q.type);
    assert.equal(q.prompt, "", "不能出现文字题干");
    assert.ok(q.options.length === 4);
    q.options.forEach((o) => assert.ok(/[\u4e00-\u9fa5]/.test(o), "选项必须是中文：" + o));
  });

  // 全对走完
  let guard = 0;
  while (!ctx.api.getG().finished && guard++ < 30) answerCurrent(ctx, true);

  assert.equal(ctx.$("resTitle").textContent, "听力练完了");
  const s = ctx.api.getS();
  assert.equal(s.listenPass[1], 3, "满星应该写进听力专练成绩");
  assert.equal(s.passed[1][1], 3, "原有的闯关进度还在");
});

test("拼错的听音选义：词进入错词区，听力星级不写", () => {
  const ctx = boot("cet4");
  playThrough(ctx);
  ctx.$("resHome").click();
  const row = ctx.doc.querySelector(".listen-row");
  [...row.querySelectorAll(".btn")].find((b) => b.textContent === "开始").click();

  let guard = 0;
  while (!ctx.api.getG().finished && guard++ < 30) answerCurrent(ctx, false);

  assert.equal(ctx.api.getS().listenPass[1], undefined, "没过关不该记星");
  const touched = Object.values(ctx.api.getS().words).filter((w) => (w.lapses || 0) > 0);
  assert.ok(touched.length > 0, "听错的词要进错词区");
});

/* ================= 长对话听写页 ================= */

const LH = read("listening.html");
const L_INLINE = LH.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];

function bootListening(opts) {
  opts = opts || {};
  const dom = new JSDOM(LH, {
    url: "http://localhost/listening.html",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  // 记录每一次真正发出去的朗读，用来检查「是不是按气口分段、有没有语气差别」
  const spoken = [];
  // 记录每一个被创建出来的 <audio>：云端通道到底请求了什么地址，只能从这里看
  const audios = [];
  const voices = opts.voices || [
    { name: "Microsoft Aria Online (Natural)", lang: "en-US", localService: false },
    { name: "Google US English", lang: "en-US", localService: true }
  ];
  win.speechSynthesis = {
    paused: false, speaking: false, pending: false,
    cancel() { this.speaking = false; this.pending = false; },
    speak(u) {
      spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch, voice: u.voice ? u.voice.name : null });
      this.speaking = true;
      setTimeout(() => {
        this.speaking = false;
        if (u.onstart) u.onstart();
        if (u.onend) u.onend();
      }, 0);
    },
    getVoices() { return voices; },
    addEventListener() {}
  };
  win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  // 云端人声走的是 <audio>，所以要模拟够真：事件、playbackRate、出错的三条路
  win.Audio = class {
    constructor(src) {
      this.src = src || "";
      this.initSrc = this.src;     // 播完会清空 src，测试要看的是「最初请求了什么」
      this.paused = true;
      this.playbackRate = 1;
      this.preservesPitch = true;
      this._l = {};
      audios.push(this);
    }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
    removeEventListener() {}
    removeAttribute() { this.src = ""; }
    load() {}
    pause() { this.paused = true; }
    play() {
      if (opts.audioFail) {
        setTimeout(() => this._fire("error"), 0);
        return Promise.reject(Object.assign(new Error("no src"), { name: "NotSupportedError" }));
      }
      this.paused = false;
      setTimeout(() => this._fire("playing"), 0);
      setTimeout(() => this._fire("ended"), 25);
      return Promise.resolve();
    }
    _fire(t) { (this._l[t] || []).forEach((f) => f({ type: t })); }
  };
  win.confirm = () => true;
  win.scrollTo = () => {};
  win.eval(["prosody.js", "sentence-audio.js", "tts.js", "dictation.js", "dialogues.js"].map(read).join("\n") + "\n" + L_INLINE +
    "\nwindow.__dlg={getD:()=>D,getIdx:()=>idx,getResults:()=>results,go:(i)=>{idx=i;renderLine();}};");
  if (opts.source) win.VQSpeech.setDialogueSource(opts.source);
  return { dom, win, doc: win.document, spoken, audios, $: (id) => win.document.getElementById(id) };
}

test("长对话听写：列表按题库渲染，点开进第一句", () => {
  const ctx = bootListening({ source: "device" });
  const cards = ctx.doc.querySelectorAll("#dlgList .dlg");
  assert.equal(cards.length, 12, "题库 12 段");
  assert.ok(cards[0].textContent.includes("咖啡店点单"));

  cards[0].click();
  assert.ok(ctx.$("drillView").classList.contains("active"));
  assert.equal(ctx.$("dlgTitle").textContent, "咖啡店点单");
  assert.equal(ctx.$("progNum").textContent, "1/6");
});

test("长对话听写：写错时逐词标红，写对时 100% 且判全对", () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  const D = ctx.win.__dlg.getD();
  const line = D.lines[0];

  // 漏掉最后两个词
  const partial = line.en.split(/\s+/).slice(0, 3).join(" ");
  ctx.$("ansInput").value = partial;
  ctx.$("submitBtn").click();

  const r = ctx.win.__dlg.getResults()[0];
  assert.ok(r.miss > 0, "漏词要被标出来");
  assert.ok(ctx.doc.querySelectorAll("#tokens .tk.miss").length > 0, "DOM 里要有红色标记");
  assert.equal(ctx.$("ansInput").disabled, true, "提交后锁住输入框");
  assert.notEqual(ctx.$("nextLine").style.display, "none", "应该出现下一句按钮");

  // 第二句写全
  ctx.$("nextLine").click();
  const line2 = D.lines[1];
  ctx.$("ansInput").value = line2.en.toLowerCase().replace(/[.,!?']/g, "");
  ctx.$("submitBtn").click();
  const r2 = ctx.win.__dlg.getResults()[1];
  assert.equal(r2.perfect, true, "只差标点大小写也要判全对");
  assert.ok(ctx.$("scoreLine").textContent.includes("100%"));
});

test("长对话听写：走完全部句子进结果页，最好成绩写进 localStorage", () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  const D = ctx.win.__dlg.getD();

  for (let i = 0; i < D.lines.length; i++) {
    ctx.$("ansInput").value = D.lines[i].en;
    ctx.$("submitBtn").click();
    if (i < D.lines.length - 1) ctx.$("nextLine").click();
  }
  ctx.$("nextLine").click();   // 最后一句 → 看结果

  assert.ok(ctx.$("doneView").classList.contains("active"));
  assert.equal(ctx.$("doneRate").textContent, "100%");
  const best = JSON.parse(ctx.win.localStorage.getItem("vq_dict_best_cafe"));
  assert.equal(best.rate, 100);
  assert.equal(ctx.$("doneLines").querySelectorAll(".sent-row").length, D.lines.length);
});

/* ================= 长对话配音：像人说话 ================= */

test("一句里有两句话就分两段念，中间留白，不是一口气连读", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(ctx.spoken.length, 2, "Good morning. / What can I get for you today? 应该是两段："
    + ctx.spoken.map((s) => s.text).join(" | "));
  assert.match(ctx.spoken[0].text, /Good morning/);
  assert.match(ctx.spoken[1].text, /What can I get/);
});

test("语速不是一条直线：同一句里两段语速/音高不同，问句尾音更高", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 500));

  const [a, b] = ctx.spoken;
  assert.notEqual(a.rate, b.rate, "两段语速完全一样就是机械感来源");
  assert.ok(b.pitch > a.pitch, `问句尾段应该更高：${a.pitch} vs ${b.pitch}`);
  assert.ok(a.rate > 0.85 && a.rate < 1.2, "正常语速要真的接近正常，不能压到 0.75 那种拖沓感：" + a.rate);
});

test("A / B 两个人声线不同，而且用的是这台设备上最好的英文音色", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();

  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 500));
  const aPitch = ctx.spoken[0].pitch;

  ctx.win.__dlg.go(1);           // 第二句是 B 说的
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 500));
  const bPitch = ctx.spoken[2].pitch;

  assert.ok(bPitch < aPitch, `B 应该比 A 低沉：${bPitch} vs ${aPitch}`);
  assert.match(ctx.spoken[0].voice, /Natural/, "有神经网络音色就优先用它，别用默认的机械音");
  assert.equal(ctx.$("whoBadge").textContent, "B", "界面上要标出谁在说话");
});

test("气口圆点数量 = 这句话要念几段，正在念的那段亮起来", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  assert.equal(ctx.doc.querySelectorAll("#dots .dot").length, 2, "第一句两句号 = 两个点");

  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(ctx.doc.querySelectorAll("#dots .dot.on").length === 1, "播放时要有一段是亮的");
});

test("慢速是整句等比放慢，点一下就能切回来", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 500));
  const normal = ctx.spoken[0].rate;

  ctx.$("slowBtn").click();
  await new Promise((r) => setTimeout(r, 500));
  const slow = ctx.spoken[ctx.spoken.length - 1].rate;
  assert.ok(slow < normal, `慢速应该更慢：${slow} vs ${normal}`);
  assert.ok(slow / normal > 0.6, "别慢成 0.5 那种，太慢会丢掉连读");
  assert.match(ctx.$("slowBtn").textContent, /慢速/);
});

test("换声音面板会列出英文音色，选完能试听", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("voiceBtn").click();
  assert.ok(ctx.$("voiceSheet").classList.contains("show"));

  const rows = ctx.doc.querySelectorAll("#voiceList .vrow");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Natural/, "自然的排前面");

  rows[1].click();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ctx.win.VQSpeech.getDialogueVoice(), "Google US English");
  assert.ok(ctx.spoken.length > 0, "选中后应该立刻试听");
});

/* ================= 听音辨汉语：答案与诚实 ================= */

const LISTEN_ZH_Q = {
  type: "listenZh", en: "abandon", zh: "放弃", ph: "əˈbændən", prompt: "",
  answer: "放弃",
  options: ["放弃", "能力", "吸收", "抽象的"],
  optDefs: [
    { en: "abandon", zh: "放弃", ph: "əˈbændən" },
    { en: "ability", zh: "能力", ph: "əˈbɪləti" },
    { en: "absorb", zh: "吸收", ph: "əbˈsɔːb" },
    { en: "abstract", zh: "抽象的", ph: "ˈæbstrækt" }
  ],
  homophones: []
};

function plantListenZh(ctx) {
  const G = openFirstLevel(ctx);
  G.qs[G.idx] = Object.assign({}, LISTEN_ZH_Q, {
    options: LISTEN_ZH_Q.options.slice(), optDefs: LISTEN_ZH_Q.optDefs.slice()
  });
  ctx.win.renderQ();
  return G;
}

test("听音辨汉语答对后把「听到的是哪个词」写出来，不只说「正确」", () => {
  const ctx = boot("cet4");
  const G = plantListenZh(ctx);
  const q = G.qs[G.idx];

  const opt = [...ctx.doc.querySelectorAll("#optionsBox .option")].find((b) => b.textContent === q.answer);
  opt.click();

  const fb = ctx.$("feedback").textContent;
  assert.match(fb, /这个音是/, "要指出听到的词：" + fb);
  assert.ok(fb.includes(q.en), "必须给出英文词形");
  assert.ok(fb.includes(q.zh), "必须给出汉语意思");
});

test("设备放不出声时不假装听过：听力星级不记，结算明说未计入", async () => {
  const ctx = boot("cet4");
  playThrough(ctx);
  ctx.$("resHome").click();

  const row = ctx.doc.querySelector(".listen-row");
  [...row.querySelectorAll(".btn")].find((b) => b.textContent === "开始").click();

  delete ctx.win.Audio;
  delete ctx.win.speechSynthesis;
  delete ctx.win.SpeechSynthesisUtterance;
  ctx.api.getG().idx = 0;
  ctx.win.renderQ();

  await new Promise((r) => setTimeout(r, 400));
  const G = ctx.api.getG();
  assert.ok(G.degraded > 0, "必须记下这一局有题没出声：" + G.degraded);

  let guard = 0;
  while (!ctx.api.getG().finished && guard++ < 30) answerCurrent(ctx, true);

  assert.equal(ctx.api.getS().listenPass[1], undefined, "没听到声音就不该记听力星级");
  assert.match(ctx.$("resSub").textContent, /未计入听力判定/, "结算要把这件事说清楚");
});

test("首页有全库听音辨汉语入口：学过的词不够时锁着，够了从全库抽", () => {
  const ctx = boot("cet4");
  assert.ok(ctx.$("listenAllBtn"), "首页要有这个入口");
  assert.equal(ctx.$("listenAllBtn").disabled, true, "一个词没学先别让点");
  assert.match(ctx.$("listenAllDesc").textContent, /学过的词还不够/);

  playThrough(ctx);
  ctx.$("resHome").click();
  assert.equal(ctx.$("listenAllBtn").disabled, false, "学过一关就该能开练");
  assert.match(ctx.$("listenAllDesc").textContent, /全库/);

  ctx.$("listenAllBtn").click();
  const G = ctx.api.getG();
  assert.equal(G.listen, true);
  assert.equal(G.u, 0, "全库模式不属于任何一个单元");
  assert.ok(G.qs.length >= 4);
  G.qs.forEach((q) => assert.equal(q.type, "listenZh"));
});

/* ================= 整句人声：云端通道 ================= */

test("听写页必须屏蔽 Referer：少了这条，云端音频一律 code 4", () => {
  const head = LH.slice(0, LH.indexOf("</head>"));
  assert.ok(/<meta name="referrer" content="no-referrer">/.test(head),
    "云端接口对带 Referer 的请求返回 0 字节，全靠这条 meta 才放行");
  const firstRes = head.search(/<(link|script)\b/);
  const metaAt = head.search(/<meta name="referrer"/);
  assert.ok(metaAt > -1 && (firstRes === -1 || metaAt < firstRes),
    "referrer 策略必须排在第一个子资源之前，否则它生效前已经发出带 Referer 的请求了");
});

test("默认就是云端人声：一句话只请求一次整句音频，不走设备合成", async () => {
  const ctx = bootListening();          // 不给偏好 = 默认
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(ctx.audios.length, 1,
    "整句一次取，而且预取的那一个要复用来播，不能请求两遍：" + ctx.audios.length);
  const src = ctx.audios[0].initSrc;
  assert.match(src, /fanyi\.baidu\.com/, "地址：" + src);
  assert.match(src, /lan=en/, "A 默认美音");
  assert.equal(ctx.spoken.length, 0, "云端能出声时不该再走设备合成");
  assert.match(ctx.$("playBig").textContent, /再听一次/);
});

test("B 说话时换成另一条声线（英音），不是同一个声音假装两个人", async () => {
  const ctx = bootListening();
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.win.__dlg.go(1);
  assert.equal(ctx.$("whoBadge").textContent, "B");
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 150));
  const uk = ctx.audios.filter((a) => /lan=uk/.test(a.initSrc));
  assert.ok(uk.length > 0, "B 必须走另一条声线，实际请求：" + ctx.audios.map((a) => a.initSrc).join(" | "));
});

test("云端取不到声音时当场退回设备合成，不让用户点第二次", async () => {
  const ctx = bootListening({ audioFail: true });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(ctx.spoken.length > 0, "必须自己退到设备合成，而不是显示没声音");
  assert.ok(!ctx.$("noVoice").classList.contains("show"), "设备能出声就不该报错");
});

test("切成设备语音后不再向云端发请求", async () => {
  const ctx = bootListening({ source: "device" });
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("playBig").click();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ctx.audios.length, 0, "设备通道不该创建任何 <audio>");
  assert.ok(ctx.spoken.length > 0);
});

test("慢速对真实录音只做轻微拉伸，且不改音高", async () => {
  const ctx = bootListening();
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("slowBtn").click();            // 打开慢速会顺带播一次
  await new Promise((r) => setTimeout(r, 150));
  const a = ctx.audios[ctx.audios.length - 1];
  assert.ok(a.playbackRate < 1, "慢速要真的慢：" + a.playbackRate);
  assert.ok(a.playbackRate >= 0.8, "真实录音拉伸过头会发糊，不能像合成那样压到 0.75：" + a.playbackRate);
  assert.equal(a.preservesPitch, true, "只慢不降调，否则听起来像磁带快没电");
});

test("声音来源面板把「要联网、句子外发」写在按钮旁边", async () => {
  const ctx = bootListening();
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  ctx.$("srcBtn").click();
  assert.ok(ctx.$("srcSheet").classList.contains("show"));
  const rows = ctx.doc.querySelectorAll("#srcList .vrow");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /云端人声/);
  assert.match(rows[0].textContent, /联网|第三方/, "代价要写在选的地方，不能只藏在文档里");
  assert.match(rows[1].textContent, /设备语音/);
});

test("云端模式下气口圆点只留一个：整句是一段音频，没有人工气口可数", () => {
  const ctx = bootListening();
  ctx.doc.querySelectorAll("#dlgList .dlg")[0].click();
  assert.equal(ctx.doc.querySelectorAll("#dots .dot").length, 1);
});
