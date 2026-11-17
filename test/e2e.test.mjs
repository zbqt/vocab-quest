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
const DATA_FILES = ["tts.js", "vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js", "grammar.js", "fsrs.js", "engine.js"];

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
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  win.confirm = () => true;

  // 必须一次性 eval：`const VOCAB_CZ` 这类顶层常量在多次 eval 之间不共享
  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE +
    "\nwindow.__t={getS:()=>S,getG:()=>G,getP:()=>P,cfg:CFG};");

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

test("发音走浏览器原生 TTS：零外链、不创建 Audio、读完按钮复位", () => {
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

  const ctx = boot("cet4");
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
  assert.equal(spoken[0].rate, 0.85);
  assert.equal(ctx.$("playBtn").textContent, "🔊 重新播放", "读完按钮回到可重播状态");
  assert.equal(ctx.$("playBtn").disabled, false);
  assert.equal(ctx.$("audioStatus").textContent, "");
});

test("没有语音引擎的浏览器：发音不抛错，按钮可重试", () => {
  const ctx = boot("cet4");
  delete ctx.win.speechSynthesis;
  delete ctx.win.SpeechSynthesisUtterance;
  ctx.win.showAudio("abandon", "");
  assert.doesNotThrow(() => ctx.win.playWord("abandon"));
  assert.equal(ctx.$("playBtn").textContent, "🔊 重试");
  assert.ok(ctx.$("audioStatus").textContent.includes("不支持"), "应说明浏览器不支持：" + ctx.$("audioStatus").textContent);
  assert.equal(ctx.$("playBtn").disabled, false);
});

test("正在朗读时点下一个词：先 cancel 再重发，新词不会被吞掉", async () => {
  const ctx = boot("cet4");
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
  const ctx = boot("cet4");
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
  const ctx = boot("cet4");
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

test("语音引擎 speak 抛异常：不崩，按钮回到可重试", () => {
  const ctx = boot("cet4");
  ctx.win.speechSynthesis = {
    speaking: false, pending: false, paused: false,
    cancel() {},
    getVoices() { return []; },
    speak() { throw new Error("engine boom"); }
  };
  ctx.win.showAudio("abandon", "");
  assert.doesNotThrow(() => ctx.win.playWord("abandon"));
  assert.equal(ctx.$("playBtn").textContent, "🔊 重试");
  assert.equal(ctx.$("playBtn").disabled, false);
});

test("合成被浏览器拦截（not-allowed）时给出可操作提示", () => {
  const ctx = boot("cet4");
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
  const ctx = boot("cet4");
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
