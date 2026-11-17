import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../fsrs.js");

/**
 * 黄金值：由 ts-fsrs 6.0.0 的 FSRS5Algorithm（enableShortTerm=false，
 * desiredRetention=0.9，bounds sMax=36500）实际跑出来的输出。
 * 本实现必须与官方误差 < 1e-6，否则说明公式被改坏了。
 */
const GOLDEN = {
  good: [ // 连续 Good 六次
    { t: 3, stability: 3.173, difficulty: 5.28243442 },
    { t: 11, stability: 10.73892592, difficulty: 5.27296793 },
    { t: 35, stability: 34.57762416, difficulty: 5.26354498 },
    { t: 101, stability: 100.74831139, difficulty: 5.25416538 },
    { t: 269, stability: 269.283835, difficulty: 5.24482893 },
    { t: 669, stability: 669.30934162, difficulty: 5.23553542 }
  ],
  mixed: [ // Good Good Again Good Hard Easy
    { t: 3, stability: 3.173, difficulty: 5.28243442 },
    { t: 11, stability: 10.73892592, difficulty: 5.27296793 },
    { t: 2, stability: 2.18577525, difficulty: 6.79056769 },
    { t: 6, stability: 6.08001125, difficulty: 6.77416379 },
    { t: 8, stability: 8.46596254, difficulty: 7.27887318 },
    { t: 43, stability: 43.39247841, difficulty: 6.82070601 }
  ],
  easy: [
    { t: 16, stability: 15.69105, difficulty: 3.22450159 },
    { t: 150, stability: 150.28356197, difficulty: 2.13012146 },
    { t: 1252, stability: 1252.22332554, difficulty: 1 }
  ],
  hard: [
    { t: 1, stability: 1.18385, difficulty: 6.48830527 },
    { t: 2, stability: 1.70736294, difficulty: 7.04050155 },
    { t: 3, stability: 2.55855731, difficulty: 7.50096685 }
  ],
  againFirst: [ // Again Good Good
    { t: 1, stability: 0.40255, difficulty: 7.1949 },
    { t: 2, stability: 2.26500942, difficulty: 7.17663617 },
    { t: 6, stability: 5.79862758, difficulty: 7.15845635 }
  ]
};

const GRADES = {
  good: [3, 3, 3, 3, 3, 3],
  mixed: [3, 3, 1, 3, 2, 4],
  easy: [4, 4, 4],
  hard: [2, 2, 2],
  againFirst: [1, 3, 3]
};

/** 用官方边界跑一遍，返回与黄金值同构的序列 */
function run(grades) {
  let card = { stability: 0, difficulty: 0, reps: 0, lapses: 0 };
  let elapsed = 0;
  const out = [];
  for (const g of grades) {
    const r = F.review(card, g, elapsed, { maxIvl: 36500 });
    out.push({ t: r.interval, stability: r.stability, difficulty: r.difficulty });
    card = { stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses };
    elapsed = r.interval;
  }
  return out;
}

test("与官方 FSRS-5 数值对齐（误差 < 1e-6）", () => {
  for (const key of Object.keys(GOLDEN)) {
    const got = run(GRADES[key]);
    GOLDEN[key].forEach((want, i) => {
      assert.equal(got[i].t, want.t, `${key} 第 ${i + 1} 次间隔`);
      assert.ok(
        Math.abs(got[i].stability - want.stability) < 1e-6,
        `${key} 第 ${i + 1} 次稳定性：期望 ${want.stability}，实际 ${got[i].stability}`
      );
      assert.ok(
        Math.abs(got[i].difficulty - want.difficulty) < 1e-6,
        `${key} 第 ${i + 1} 次难度：期望 ${want.difficulty}，实际 ${got[i].difficulty}`
      );
    });
  }
});

test("初始值：Good 起步 3 天，Easy 明显更久，Again 当天重来", () => {
  const g = (grade) => F.review({ stability: 0, difficulty: 0, reps: 0 }, grade, 0, { maxIvl: 36500 });
  assert.equal(g(1).interval, 1, "Again 隔天就再来");
  assert.equal(g(3).interval, 3, "Good 3 天");
  assert.equal(g(4).interval, 16, "Easy 16 天");
  assert.ok(g(4).interval > g(3).interval, "熟练的间隔必须长于记得");
  assert.ok(g(2).difficulty > g(3).difficulty, "勉强 → 难度更高");
  assert.ok(g(1).difficulty > g(2).difficulty, "忘记 → 难度最高");
});

test("遗忘曲线：S=1 时 R(1)=0.9，且随时间单调下降", () => {
  assert.ok(Math.abs(F.retrievability(1, 1) - 0.9) < 1e-9);
  assert.equal(F.retrievability(0, 1), 1);
  let prev = 1;
  for (const t of [0, 1, 2, 5, 10, 30, 100]) {
    const r = F.retrievability(t, 10);
    assert.ok(r <= prev + 1e-12, `t=${t} 的保持率不该上升`);
    prev = r;
  }
  assert.ok(F.retrievability(30, 10) < F.retrievability(5, 10), "越久越记不住");
});

test("间隔：恒为正、单调、且被业务上限截断", () => {
  assert.ok(F.intervalFor(0.01) >= 1);
  assert.ok(F.intervalFor(5) < F.intervalFor(50));
  assert.ok(F.intervalFor(1e6) <= F.MAX_IVL, "默认不超过一年");
  assert.equal(F.intervalFor(1e6, 0.9, 36500), 36500);
  assert.equal(F.intervalFor(10, 0.9, 36500), 10, "S 与间隔同尺度（R=0.9 时）");
});

test("同日重复复习不会让间隔膨胀", () => {
  const first = F.review({ stability: 0, difficulty: 0, reps: 0 }, 3, 0);
  const again = F.review(
    { stability: first.stability, difficulty: first.difficulty, reps: 1, lapses: 0 },
    3, 0
  );
  assert.ok(
    Math.abs(again.stability - first.stability) < 1e-9,
    "同一天再答对一次，稳定性不该变（elapsed=0 → 遗忘量 0）"
  );
  assert.equal(again.interval, first.interval);
});

test("答错后稳定性回退，但不会归零", () => {
  let card = { stability: 0, difficulty: 0, reps: 0, lapses: 0 };
  for (let i = 0; i < 3; i++) {
    const r = F.review(card, 3, i === 0 ? 0 : card.interval);
    card = { stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses };
    card.interval = r.interval;
  }
  const before = card.stability;
  const bad = F.review(card, 1, card.interval);
  assert.ok(bad.stability < before, "答错要回退");
  assert.ok(bad.stability > 0, "但不归零");
  assert.equal(bad.lapses, 1, "记一次遗忘");
  assert.ok(bad.interval < card.interval, "马上要再见到它");
});

test("评分推断：四选一与新卡不给 Easy，回忆方向够快才给", () => {
  // 四选一：选项里摆着答案，答对只能证明认得出 → 上限 Good
  assert.equal(F.gradeOf(true, "match", 1500), F.GRADES.GOOD);
  assert.equal(F.gradeOf(true, "match", 6000), F.GRADES.GOOD);
  assert.equal(F.gradeOf(true, "match", 20000), F.GRADES.HARD);
  assert.equal(F.gradeOf(false, "match", 1000), F.GRADES.AGAIN);

  // 新卡第一次：无论多快都不给 Easy
  assert.equal(F.gradeOf(true, "spell", 3000, true), F.GRADES.GOOD);
  assert.equal(F.gradeOf(true, "spell", 3000, false), F.GRADES.EASY, "复习时又快又对才算熟练");
  assert.equal(F.gradeOf(true, "spell", 20000, false), F.GRADES.HARD);

  // 缺反应时数据 → 保守 Good
  assert.equal(F.gradeOf(true, "spell", 0, false), F.GRADES.GOOD);
});

test("识别不等于回忆：四选一的首次间隔远短于拼写方向", () => {
  const VQ = require("../engine.js");
  const unit = [{ id: 1, levels: 1 }];
  const a = VQ.createState(unit, "2026-11-17");
  const b = VQ.createState(unit, "2026-11-17");
  VQ.recordAnswer(a, { word: "x", type: "match", correct: true, today: "2026-11-17", rt: 1200 });
  VQ.recordAnswer(b, { word: "x", type: "spell", correct: true, today: "2026-11-17", rt: 1200 });
  const ivlA = VQ.diffDays("2026-11-17", a.words.x.dueAt);
  const ivlB = VQ.diffDays("2026-11-17", b.words.x.dueAt);
  assert.equal(ivlA, 3, "四选一第一次答对 → 3 天后再见");
  assert.ok(ivlB >= ivlA, "拼写同样是第一次，间隔不该更短");
});

test("难度始终锁在 1~10，稳定性不低于下限", () => {
  let card = { stability: 0, difficulty: 0, reps: 0, lapses: 0 };
  for (let i = 0; i < 30; i++) {
    const r = F.review(card, 1, 3);
    card = { stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses };
    assert.ok(r.difficulty >= 1 && r.difficulty <= 10);
    assert.ok(r.stability >= 0.01);
  }
});
