import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VQ = require("../engine.js");

const UNITS = [{ id: 1, levels: 2 }, { id: 2, levels: 3 }];
const TODAY = "2026-11-17";

test("星级：必须答满全部题目，3 星可达", () => {
  assert.equal(VQ.starsFor(12, 12), 3);
  assert.equal(VQ.starsFor(11, 12), 2);
  assert.equal(VQ.starsFor(10, 12), 1);
  assert.equal(VQ.starsFor(9, 12), 1);
  assert.equal(VQ.starsFor(8, 12), 0);

  // 14 题一局（12 词 + 2 语法）
  assert.equal(VQ.passNeedFor(14), 11);
  assert.equal(VQ.starsFor(14, 14), 3);
  assert.equal(VQ.starsFor(13, 14), 2);
  assert.equal(VQ.starsFor(12, 14), 1);
  assert.equal(VQ.starsFor(11, 14), 1);
  assert.equal(VQ.starsFor(10, 14), 0);
});

test("长期掌握：需 3 个不同自然日 + 2 个方向", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "abandon", type: "match", correct: true, today: "2026-11-17" });
  assert.equal(VQ.isLongTerm(s.words.abandon), false, "只对 1 次不算");

  VQ.recordAnswer(s, { word: "abandon", type: "match", correct: true, today: "2026-11-18" });
  assert.equal(VQ.isLongTerm(s.words.abandon), false, "只有 2 天、1 个方向");

  VQ.recordAnswer(s, { word: "abandon", type: "spell", correct: true, today: "2026-11-20" });
  assert.equal(VQ.isLongTerm(s.words.abandon), true, "3 天 + 2 方向 → 长期掌握");

  // 之后又答错 → 立刻降级
  VQ.recordAnswer(s, { word: "abandon", type: "match", correct: false, today: "2026-11-25" });
  assert.equal(VQ.isLongTerm(s.words.abandon), false, "最近一次错，撤销掌握");
});

test("掌握口径：答对一次不再计入长期掌握", () => {
  const s = VQ.createState(UNITS, TODAY);
  for (let i = 0; i < 40; i++) {
    VQ.recordAnswer(s, { word: "w" + i, type: "match", correct: true, today: TODAY });
  }
  const c = VQ.counts(s);
  assert.equal(c.mastered, 0);
  assert.equal(c.learning, 40);
});

test("错词：连续答对 2 次后退出巩固区，且间隔被拉长", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: false, today: TODAY });
  let ws = s.words.adopt;
  assert.equal(VQ.inRescue(ws), true);
  assert.equal(ws.dueAt, TODAY, "答错的词当天就能再练");
  assert.ok(VQ.dueList(s, TODAY).some((x) => x.word === "adopt"), "错词当天进入复习队列");

  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: true, today: TODAY });
  assert.equal(VQ.inRescue(s.words.adopt), true, "对 1 次还不够");

  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: true, today: "2026-11-18" });
  ws = s.words.adopt;
  assert.equal(VQ.inRescue(ws), false, "连续 2 次对 → 移出错词区");
  assert.equal(ws.streak, 2);
  assert.ok(VQ.diffDays("2026-11-18", ws.dueAt) >= 1, "答对后不再当天重复");
  assert.equal(VQ.dueList(s, "2026-11-18").some((x) => x.word === "adopt"), false);
  assert.ok(ws.s > 0, "稳定性已由 FSRS 接管");
});

test("复习队列：错词优先，到期久的优先", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "a", type: "match", correct: false, today: "2026-11-14" });
  VQ.recordAnswer(s, { word: "b", type: "spell", correct: false, today: "2026-11-15" });
  VQ.recordAnswer(s, { word: "c", type: "match", correct: true, today: "2026-11-13" }); // 3 天后到期
  const q = VQ.dueList(s, TODAY);
  assert.deepEqual(q.slice(0, 2).map((x) => x.word).sort(), ["a", "b"], "错词排在最前");
  assert.ok(q.some((x) => x.word === "c"), "已到期的词也要在队列里");
});

test("出题：12 个词全部考到，语法题叠加不挤占", () => {
  const words = Array.from({ length: 12 }, (_, i) => ["w" + i, "释义" + i, "ˈw" + i]);
  const grammar = [
    { q: "g1", options: ["a", "b"], a: "a", tip: "" },
    { q: "g2", options: ["a", "b"], a: "a", tip: "" },
    { q: "g3", options: ["a", "b"], a: "a", tip: "" }
  ];
  const sess = VQ.buildSession({
    words, grammar, grammarN: 2, spellEvery: 4, mode: "play",
    rng: (arr) => arr.slice()
  });
  assert.equal(sess.total, 14, "12 词 + 2 语法");
  assert.equal(sess.passNeed, 11);

  const asked = new Set(sess.questions.filter((q) => q.type !== "grammar").map((q) => q.en));
  assert.equal(asked.size, 12, "每个词都出现过");
  assert.equal(sess.questions.filter((q) => q.type === "grammar").length, 2);
  assert.equal(sess.questions.filter((q) => q.type === "match" || q.type === "spell").length, 12);

  const match = sess.questions.find((q) => q.type === "match");
  assert.equal(match.options.length, 4);
  assert.ok(match.options.includes(match.answer));
});

test("旧存档迁移：虚高掌握清零、急救包转状态、通关数重算", () => {
  const old = {
    hp: 2, lv: 9, coin: 500, exp: 120, reviewed: 30, shufMode: true,
    mastered: 700, masteredWords: ["abandon", "ability", "able", "absent"],
    rescue: ["adopt", "adapt", "abandon"],
    lastReviewDate: "2026-11-16",
    passed: { 1: { 1: 1, 2: 0 }, 2: { 1: 2, 2: 0, 3: 0 } },
    passedS: {},
    events: null
  };
  const s = VQ.normalizeState(old, { units: UNITS, bank: ["abandon", "ability", "able", "absent", "adopt", "adapt"], today: TODAY });

  const c = VQ.counts(s);
  assert.equal(c.mastered, 0, "旧掌握数据不冒充长期记忆");
  assert.equal(c.rescue, 3, "3 个错词都进入巩固区（abandon 同时被标掌握，错词状态优先）");
  assert.equal(s.passedCount, 2, "通关数按实际地图重算");
  assert.equal(s.passedCountS, 0);
  assert.equal(s.shufMode, true);
  assert.equal(s.words.adopt.lapses, 1);
  assert.equal(s.words.adopt.streak, 0);
  assert.equal(s.words.adopt.dueAt, TODAY);
});

test("归一化可重复执行且不改变结果", () => {
  const s1 = VQ.normalizeState({ passed: {}, words: {}, rescue: ["x"] }, { units: UNITS, bank: ["x"], today: TODAY });
  const s2 = VQ.normalizeState(JSON.parse(JSON.stringify(s1)), { units: UNITS, bank: ["x"], today: TODAY });
  assert.deepEqual(s2, s1);
});

test("事件日志是环形缓冲，不会无限膨胀", () => {
  const s = VQ.createState(UNITS, TODAY);
  for (let i = 0; i < VQ.EVENT_CAP + 120; i++) VQ.appendEvent(s, { k: i });
  assert.equal(s.events.length, VQ.EVENT_CAP);
  assert.equal(s.events[0].k, 120);
  assert.equal(s.events[s.events.length - 1].k, VQ.EVENT_CAP + 119);
});

test("乱序题库固定种子可复现", () => {
  const a = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.deepEqual(VQ.seededShuffle(a, 42), VQ.seededShuffle(a, 42));
  assert.notDeepEqual(VQ.seededShuffle(a, 42), VQ.seededShuffle(a, 43));
  assert.deepEqual(VQ.seededShuffle(a, 42).slice().sort(), a, "不丢词");
});

/* ================= P1：今日队列 ================= */

const BANK8 = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"];

test("今日队列：复习与新词都排进去，新词按词库顺序", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "w1", type: "match", correct: false, today: TODAY }); // 错词，当天到期
  const q = VQ.dailyQueue(s, { today: TODAY, total: 6, newMax: 3, newFloor: 3, order: BANK8 });

  assert.equal(q.reviewCount, 1, "1 个到期复习");
  assert.equal(q.newCount, 3, "新词上限 3");
  assert.equal(q.total, 4);
  assert.equal(q.words[0].word, "w1", "错词排最前");
  assert.equal(q.words[0].rescue, true);
  const fresh = q.words.filter((x) => x.isNew).map((x) => x.word);
  assert.deepEqual(fresh, ["w2", "w3", "w4"], "跳过已学过的 w1，按顺序取");
  assert.ok(q.minutes >= 1);
});

test("今日队列：不把已学过的词当新词发", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "w1", type: "match", correct: true, today: TODAY });
  const q = VQ.dailyQueue(s, { today: TODAY, total: 4, newMax: 4, newFloor: 4, order: BANK8 });
  assert.equal(q.words.some((x) => x.word === "w1"), false, "w1 已学，不该再当新词");
  assert.deepEqual(q.words.map((x) => x.word), ["w2", "w3", "w4", "w5"]);
});

test("今日队列：到期词多时不吃掉新词配额", () => {
  const s = VQ.createState(UNITS, TODAY);
  for (let i = 0; i < 30; i++) {
    VQ.recordAnswer(s, { word: "d" + i, type: "match", correct: false, today: TODAY });
  }
  const q = VQ.dailyQueue(s, { today: TODAY, total: 20, newMax: 10, newFloor: 10, order: BANK8 });
  assert.equal(q.reviewCount, 10, "复习最多占 total - 新词保底");
  assert.equal(q.newCount, 8, "新词仍保留配额（题库只剩 8 个）");
  assert.equal(q.dueCount, 30, "到期总数如实报告");
});

test("今日队列：新词顺序完全由传入的 order 决定", () => {
  const s = VQ.createState(UNITS, TODAY);
  const reordered = ["w6", "w7", "w8", "w1", "w2", "w3", "w4", "w5"];
  const q = VQ.dailyQueue(s, { today: TODAY, total: 3, newMax: 3, newFloor: 3, order: reordered });
  assert.deepEqual(q.words.map((x) => x.word), ["w6", "w7", "w8"]);
  assert.equal(q.remainingNew, 8);
});

test("今日队列：只剩一个词时 remainingNew 归零", () => {
  const s = VQ.createState(UNITS, TODAY);
  BANK8.slice(0, 7).forEach((w) => {
    VQ.recordAnswer(s, { word: w, type: "match", correct: true, today: TODAY });
  });
  const q = VQ.dailyQueue(s, { today: TODAY, total: 10, newMax: 10, newFloor: 10, order: BANK8 });
  assert.equal(q.newCount, 1);
  assert.equal(q.remainingNew, 1);
  assert.equal(q.daysToFinish, 1);
});

test("连续学习天数：断一天就归零，今天没学不清零", () => {
  const s = VQ.createState(UNITS, TODAY);
  ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"].forEach((d) => VQ.markDay(s, d));
  assert.equal(VQ.streakDays(s, "2026-11-17"), 4);
  assert.equal(VQ.streakDays(s, "2026-11-18"), 4, "今天还没开始，连续记录不断");
  assert.equal(VQ.streakDays(s, "2026-11-20"), 0, "断了一天以上就重新计数");

  const empty = VQ.createState(UNITS, TODAY);
  assert.equal(VQ.streakDays(empty, TODAY), 0);
  VQ.markDay(empty, TODAY);
  VQ.markDay(empty, TODAY);
  assert.equal(VQ.streakDays(empty, TODAY), 1, "同一天学两次只算一天");
});

/* ================= P1：定级测试 ================= */

const BANK60 = Array.from({ length: 60 }, (_, i) => ["word" + i, "释义" + i, ""]);
const identity = (a) => a.slice();

test("定级出题：覆盖全部层，题数正确，每题只有一个正确释义", () => {
  const plan = VQ.placementPlan(BANK60, { bands: 6, perBand: 5, rng: identity });
  assert.equal(plan.questions.length, 30, "6 层 × 5 题");
  assert.equal(plan.size, 60);
  const bands = new Set(plan.questions.map((q) => q.band));
  assert.equal(bands.size, 6, "6 层都出了题");
  plan.questions.forEach((q) => {
    assert.equal(q.options.length, 4);
    assert.equal(q.options.filter((o) => o === q.answer).length, 1, "正确项不重复");
    assert.equal(new Set(q.options).size, 4, "选项去重");
  });
});

test("定级估算：四选一必须扣掉蒙对的 25%", () => {
  const plan = VQ.placementPlan(BANK60, { bands: 6, perBand: 5, rng: identity });
  // 全对：确实全会
  const all = VQ.placementResult(plan.questions.map((q) => ({ band: q.band, correct: true })), plan);
  assert.equal(all.estimate, 60);

  // 全错：0
  const none = VQ.placementResult(plan.questions.map((q) => ({ band: q.band, correct: false })), plan);
  assert.equal(none.estimate, 0);

  // 前 3 层全对、后 3 层全错 → 约一半
  const half = VQ.placementResult(
    plan.questions.map((q) => ({ band: q.band, correct: q.band <= 3 })), plan
  );
  assert.equal(half.estimate, 30);
  assert.equal(half.skip, 0, "skip 只统计真正答对并带回 word 的词");

  // 带 word 时，答对的词会被收集起来供 applyPlacement 使用
  const withWord = VQ.placementResult(
    plan.questions.map((q) => ({ band: q.band, word: q.en, correct: q.band <= 3 })), plan
  );
  assert.equal(withWord.skip, 15, "30 题里前 3 层 15 题答对");
  assert.equal(withWord.known.length, 15);
});

test("定级估算：全蒙对一半时估不出词汇量（扣猜测率生效）", () => {
  const plan = { bands: 4, size: 100 };
  // 每层 4 题错 2 对 2 → 观察正确率 50%，扣掉猜测率后真实掌握率 1/3
  const answers = [];
  for (let b = 1; b <= 4; b++) {
    for (let i = 0; i < 4; i++) answers.push({ band: b, correct: i < 2 });
  }
  const r = VQ.placementResult(answers, plan);
  const band = r.bands[0];
  assert.ok(Math.abs(band.rate - 0.5) < 1e-9);
  assert.ok(Math.abs(band.trueRate - 1 / 3) < 1e-9, "0.5 → (0.5-0.25)/0.75 = 1/3");
  assert.equal(r.estimate, Math.round(100 / 3));
});

test("应用定级：只标记真正答对的词，并给 60 天后验证一次", () => {
  const s = VQ.createState(UNITS, TODAY);
  const res = {
    estimate: 40, bands: [{ band: 1, trueRate: 1 }, { band: 2, trueRate: 0 }],
    known: ["w1", "w2"]
  };
  VQ.applyPlacement(s, res, { today: TODAY });
  assert.equal(s.words.w1.placed, true);
  assert.equal(s.words.w1.dueAt, VQ.addDays(TODAY, 60), "不是永久跳过，60 天后会被验证");
  assert.equal(s.words.w3, undefined, "没测到的词不动");
  assert.equal(s.placement.estimate, 40);

  // 被跳过的词不再出现在新词队列里
  const q = VQ.dailyQueue(s, { today: TODAY, total: 4, newMax: 4, newFloor: 4, order: BANK8 });
  assert.deepEqual(q.words.map((x) => x.word), ["w3", "w4", "w5", "w6"]);
});

test("定级会重排新词顺序：掌握率最低的区间先学，层内保持原序", () => {
  const bank = Array.from({ length: 12 }, (_, i) => "w" + i);
  const placement = { bands: [{ band: 1, trueRate: 1 }, { band: 2, trueRate: 0 }, { band: 3, trueRate: 0.5 }] };
  const order = VQ.learnOrder(bank, placement);
  assert.deepEqual(order, [
    "w4", "w5", "w6", "w7",           // 第 2 层：0%，最生，先学
    "w8", "w9", "w10", "w11",         // 第 3 层：50%
    "w0", "w1", "w2", "w3"            // 第 1 层：100%，最后
  ]);
  assert.deepEqual(VQ.learnOrder(bank, null), bank, "没定级就按原序");
  assert.deepEqual(VQ.learnOrder(bank, { bands: [] }), bank);
});

test("归一化幂等：补齐 FSRS 参数后重复执行不再变化", () => {
  const raw = { passed: {}, words: { x: { seen: 3, lapses: 1, streak: 2, dueAt: TODAY } } };
  const a = VQ.normalizeState(raw, { units: UNITS, bank: ["x"], today: TODAY });
  assert.ok(a.words.x.reps > 0 && a.words.x.s > 0, "旧档补了 FSRS 初值");
  const b = VQ.normalizeState(JSON.parse(JSON.stringify(a)), { units: UNITS, bank: ["x"], today: TODAY });
  assert.deepEqual(b.words.x, a.words.x);
});

test("「这词我会」：跳过但不算真会，60 天后抽查一次", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "w1", type: "match", correct: false, today: TODAY });
  assert.equal(VQ.inRescue(s.words.w1), true);

  VQ.markKnown(s, "w1", { today: TODAY });
  const ws = s.words.w1;
  assert.equal(ws.placed, true);
  assert.equal(ws.dueAt, VQ.addDays(TODAY, 60), "不是永久跳过");
  assert.ok(ws.s >= 20, "稳定性至少 20 天，明天不会又冒出来");
  assert.equal(VQ.dueList(s, TODAY).some((x) => x.word === "w1"), false, "今天不再出现");
  assert.equal(VQ.isLongTerm(ws), false, "跳过的词不算长期掌握");

  // 抽查答错 → 回到正常流程
  VQ.recordAnswer(s, { word: "w1", type: "match", correct: false, today: VQ.addDays(TODAY, 60) });
  assert.equal(s.words.w1.placed, true, "placed 只是历史标记，不阻止复习");
  assert.equal(s.words.w1.dueAt, VQ.addDays(TODAY, 60), "答错当天重练");
  assert.equal(VQ.inRescue(s.words.w1), true);
});

test("「这词我会」：跳过之后的词不再作为新词发放", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.markKnown(s, "w1", { today: TODAY });
  const q = VQ.dailyQueue(s, { today: TODAY, total: 4, newMax: 4, newFloor: 4, order: BANK8 });
  assert.deepEqual(q.words.map((x) => x.word), ["w2", "w3", "w4", "w5"]);
});

test("语法题不会排在第一题（第一题留给本关第一个单词）", () => {
  const words = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"].map((w) => [w, "释义" + w, ""]);
  const grammar = [1, 2, 3].map((n) => ({ q: "语法题" + n, a: "A", options: ["A", "B"], tip: "" }));
  for (let i = 0; i < 40; i++) {
    const sess = VQ.buildSession({ words: words.slice(), grammar: grammar.slice(), grammarN: 3, spellEvery: 3, mode: "play" });
    assert.notEqual(sess.questions[0].type, "grammar", "第 " + (i + 1) + " 次生成时语法题跑到第一题了");
    assert.equal(sess.questions.filter((q) => q.type === "grammar").length, 3, "语法题数量不能少");
  }
});

/* ================= 听音选词 ================= */

function listenWords(n) {
  return Array.from({ length: n }, (_, i) => ["w" + (i + 1), "释义" + (i + 1), "w" + (i + 1)]);
}

test("听音题按 listenEvery 的比例出现，且题干里一个字都不许有", () => {
  const words = listenWords(12);
  const sess = VQ.buildSession({ words, listenEvery: 4, spellEvery: 0, mode: "play", pool: words });
  const listens = sess.questions.filter((q) => q.type === "listen");
  assert.equal(listens.length, 3, "12 个词、每 4 个一道，应该正好 3 道");
  listens.forEach((q) => {
    assert.equal(q.prompt, "", "题干不能留任何文字线索，否则听音题等于白出");
    assert.equal(q.options.length, 4, "四个选项");
    assert.ok(q.options.includes(q.answer), "正确答案必须在选项里");
    assert.equal(q.options.filter((o) => o === q.answer).length, 1);
    assert.ok(q.optDefs && q.optDefs.length === 4, "要带上答完后展示的词条");
  });
});

test("听音题不会把同一个词塞进两个选项", () => {
  // 跨词库合并后的池子里重复词很常见，重复选项会让听音题变成「选哪个都一样」
  const dup = [["apple", "苹果", ""], ["apple", "苹果（重复）", ""], ["pear", "梨", ""], ["peach", "桃", ""], ["plum", "李子", ""], ["grape", "葡萄", ""]];
  const sess = VQ.buildSession({ words: [dup[0]], wordTypes: ["listen"], listenEvery: 0, spellEvery: 0, pool: dup });
  const q = sess.questions[0];
  const uniq = new Set(q.options);
  assert.equal(uniq.size, q.options.length, "选项必须互不相同：" + q.options.join(","));
});

test("可以点名要一道听音题（wordTypes 覆盖排课节奏）", () => {
  const words = listenWords(5);
  const sess = VQ.buildSession({ words, wordTypes: ["listen"], listenEvery: 0, spellEvery: 0, mode: "review", pool: words });
  assert.equal(sess.questions[0].type, "listen");
  assert.equal(sess.questions[1].type, "match", "没点名的词还是认词题");
});

test("listenEvery 为 0 时一道听音题都不出（复习模式不该有新考法）", () => {
  const words = listenWords(12);
  const sess = VQ.buildSession({ words, listenEvery: 0, spellEvery: 0, mode: "review", pool: words });
  assert.equal(sess.questions.filter((q) => q.type === "listen").length, 0);
});

test("拼写和听音撞在一起时拼写优先，不会一题两种要求", () => {
  const words = listenWords(12);
  // spellEvery=4 与 listenEvery=4 在同一批下标上打架
  const sess = VQ.buildSession({ words, listenEvery: 4, spellEvery: 4, mode: "play", pool: words });
  sess.questions.forEach((q) => {
    assert.ok(["match", "spell", "listen", "grammar"].includes(q.type), "题型必须是已知的四种之一：" + q.type);
    if (q.type === "listen") {
      assert.equal(q.prompt, "", "听音题不该带文字题干");
      assert.ok(q.options && q.options.length === 4);
    }
  });
  assert.equal(sess.total, 12, "不能因为排课逻辑丢题或多题");
});

/* ================= 听音选义 / 看英文选中文 ================= */

const zhWords = [
  ["abandon", "v. 丢弃；放弃", "ə'bændən"],
  ["ability", "n. 能力", "ə'bɪləti"],
  ["aboard", "adv. 在船上", "ə'bɔrd"],
  ["absence", "n. 缺席", "'æbsns"],
  ["absolute", "adj. 绝对的", "'æbsəluːt"],
  ["absorb", "v. 吸收", "əb'sɔrb"]
];

test("听音选义：只给声音，选项是四个中文，答案在其中", () => {
  const sess = VQ.buildSession({ words: [zhWords[0]], wordTypes: ["listenZh"], spellEvery: 0, listenEvery: 0, mode: "listen", pool: zhWords });
  const q = sess.questions[0];
  assert.equal(q.type, "listenZh");
  assert.equal(q.prompt, "", "不能给文字题干，否则等于把答案念出来");
  assert.equal(q.answer, "v. 丢弃；放弃");
  assert.equal(q.options.length, 4, "四选一");
  assert.equal(q.options.filter((o) => o === q.answer).length, 1);
  // 选项必须是中文释义，不能混进英文词形
  q.options.forEach((o) => assert.ok(/[\u4e00-\u9fa5]/.test(o), "选项应该是中文：" + o));
  assert.equal(new Set(q.options).size, 4, "选项不能重复");
  assert.equal(q.optDefs.length, 4, "答完要能摊开四个词的词形与释义");
});

test("看英文选中文：露词形，选项仍是中文（听音题的无音频降级形态）", () => {
  const q = VQ.buildQuestion(zhWords[1], 0, { forceType: "lookZh", pool: zhWords });
  assert.equal(q.type, "lookZh");
  assert.equal(q.prompt, "ability");
  assert.equal(q.answer, "n. 能力");
  q.options.forEach((o) => assert.ok(/[\u4e00-\u9fa5]/.test(o)));
});

test("释义完全相同的两个词不会同时出现在选项里（否则一题两个正确答案）", () => {
  const dup = [
    ["happy", "adj. 高兴的", ""],
    ["glad", "adj. 高兴的", ""],
    ["sad", "adj. 悲伤的", ""],
    ["angry", "adj. 生气的", ""],
    ["tired", "adj. 累的", ""]
  ];
  const q = VQ.buildQuestion(dup[0], 0, { forceType: "listenZh", pool: dup });
  assert.equal(new Set(q.options).size, q.options.length, "选项必须互不相同：" + q.options.join("|"));
  assert.equal(q.options.filter((o) => o === "adj. 高兴的").length, 1);
});

test("全 listenZh 的一局：每道题都是听音选义，一道拼写都不掺", () => {
  const sess = VQ.buildSession({
    words: zhWords, wordTypes: zhWords.map(() => "listenZh"),
    spellEvery: 0, listenEvery: 0, mode: "listen", pool: zhWords
  });
  assert.equal(sess.total, zhWords.length);
  sess.questions.forEach((q) => {
    assert.equal(q.type, "listenZh");
    assert.equal(q.prompt, "");
  });
});

test("听音选义记在 listen 通路上，不是认词通路", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "abandon", type: "listenZh", correct: true, today: TODAY });
  assert.ok(s.words.abandon.dirs.listen, "应该记 listen 方向");
  assert.equal(s.words.abandon.dirs.recog, undefined, "不该冒充认词");
  // lookZh 相反：它是「看见就懂」，记 recog
  VQ.recordAnswer(s, { word: "ability", type: "lookZh", correct: true, today: TODAY });
  assert.ok(s.words.ability.dirs.recog);
  assert.equal(s.words.ability.dirs.listen, undefined);
});

test("听力专练星级能存能读，脏值被丢掉", () => {
  const s = VQ.normalizeState({
    passed: { 1: { 1: 3, 2: 0 }, 2: { 1: 1, 2: 0, 3: 0 } },
    listenPass: { 1: 2, 2: 7, 3: "3", 4: 0 }
  }, { units: UNITS, today: TODAY });
  assert.equal(s.listenPass[1], 2, "合法星级保留");
  assert.equal(s.listenPass[2], undefined, "7 星不存在，丢掉");
  assert.equal(s.listenPass[3], undefined, "字符串不算数");
  assert.equal(s.listenPass[4], undefined, "0 星等同于没练过，不占位");
});

test("听力专练取词：只从学过的词里抽，生词一律不出现", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "abandon", type: "match", correct: true, today: TODAY });
  VQ.recordAnswer(s, { word: "ability", type: "match", correct: false, today: TODAY });
  // 报错也是见过了 —— 见过就该能练
  const picked = VQ.listeningWords(s, zhWords, { n: 12 });
  const names = picked.map((w) => w[0]).sort();
  assert.deepEqual(names, ["abandon", "ability"], "只出见过的那两个词");
});

test("听力专练取词：学过的词不够时返回多少算多少，不拿生词凑数", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "abandon", type: "match", correct: true, today: TODAY });
  const picked = VQ.listeningWords(s, zhWords, { n: 12 });
  assert.equal(picked.length, 1);
});

/* ================= 听音辨汉语：同音词与「没听到」 ================= */

const homoWords = [
  ["see", "v. 看见", "siː"],
  ["sea", "n. 大海", "siː"],
  ["piece", "n. 一块", "piːs"],
  ["peace", "n. 和平", "piːs"],
  ["book", "n. 书", "bʊk"],
  ["desk", "n. 书桌", "desk"]
];

test("听音辨汉语：同音词不能进选项，否则一道题两个正确答案", () => {
  // 听到 /siː/ 选「看见」和选「大海」都算听对了，这题就没法判
  for (let i = 0; i < 20; i++) {
    const q = VQ.buildQuestion(homoWords[0], 0, { forceType: "listenZh", pool: homoWords });
    assert.equal(q.answer, "v. 看见");
    assert.ok(!q.options.includes("n. 大海"), "同音词 sea 不该出现在选项里：" + q.options.join("|"));
    assert.equal(new Set(q.options).size, q.options.length);
  }
});

test("听音辨汉语：答案的同音词会被点名，告诉用户「光靠声音分不出来」", () => {
  const q = VQ.buildQuestion(homoWords[0], 0, { forceType: "listenZh", pool: homoWords });
  assert.deepEqual(q.homophones, ["sea"]);
});

test("看英文选中文不受同音影响：词形已经限定答案，同音词可以当干扰项", () => {
  const q = VQ.buildQuestion(homoWords[0], 0, { forceType: "lookZh", pool: homoWords });
  assert.equal(q.prompt, "see");
  assert.equal(q.answer, "v. 看见");
});

test("听音选词同样排除同音词：听到 /siː/ 时 see 和 sea 都在选项里等于没法答", () => {
  for (let i = 0; i < 20; i++) {
    const q = VQ.buildQuestion(homoWords[0], 0, { forceType: "listen", pool: homoWords });
    assert.equal(q.type, "listen");
    assert.ok(!q.options.includes("sea"), "同音词不该进选项：" + q.options.join("|"));
    assert.ok(q.options.includes("see"));
  }
});

test("看中文选英文时同音词可以留下（题干已经说明是哪个词义）", () => {
  const q = VQ.buildQuestion(homoWords[0], 0, { forceType: "", pool: homoWords, spellEvery: 0 });
  assert.equal(q.type, "match");
  assert.equal(q.answer, "see");
  assert.equal(q.options.length, 4, "四选一");
  assert.equal(new Set(q.options).size, 4, "选项不能重复");
  assert.ok(q.options.includes("see"));
});

test("音标写法不同但同音，也要被认出来", () => {
  assert.equal(VQ.soundKey("ˈsiː"), VQ.soundKey("si"));
  assert.equal(VQ.soundKey("/piːs/"), VQ.soundKey("piːs"));
  assert.notEqual(VQ.soundKey("siː"), VQ.soundKey("sɪ"));
});
