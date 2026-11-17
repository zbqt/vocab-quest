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

test("错词：连续答对 2 次后退出巩固区，仍按间隔复习", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: false, today: TODAY });
  let ws = s.words.adopt;
  assert.equal(VQ.inRescue(ws), true);
  assert.ok(VQ.dueList(s, TODAY).some((x) => x.word === "adopt"), "错词当天进入复习队列");

  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: true, today: TODAY });
  assert.equal(VQ.inRescue(s.words.adopt), true, "对 1 次还不够");

  VQ.recordAnswer(s, { word: "adopt", type: "match", correct: true, today: "2026-11-18" });
  ws = s.words.adopt;
  assert.equal(VQ.inRescue(ws), false, "连续 2 次对 → 移出错词区");
  assert.equal(ws.streak, 2);
  assert.equal(ws.dueAt, VQ.addDays("2026-11-18", 3), "按 3 天间隔排下一次");
  assert.equal(VQ.dueList(s, "2026-11-18").some((x) => x.word === "adopt"), false);
});

test("复习队列：错词优先，到期久的优先", () => {
  const s = VQ.createState(UNITS, TODAY);
  VQ.recordAnswer(s, { word: "a", type: "match", correct: false, today: "2026-11-14" });
  VQ.recordAnswer(s, { word: "b", type: "match", correct: false, today: "2026-11-15" });
  VQ.recordAnswer(s, { word: "c", type: "match", correct: true, today: "2026-11-16" }); // due 17
  const q = VQ.dueList(s, TODAY);
  assert.deepEqual(q.slice(0, 2).map((x) => x.word), ["a", "b"]);
  assert.ok(q.some((x) => x.word === "c"));
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
