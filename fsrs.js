/*!
 * VQFRS — FSRS-5 记忆调度内核（手写实现，零依赖）
 *
 * 为什么不用 ts-fsrs：本项目是「双击打开就能用」的静态站，不跑打包。
 * 引入 npm 包会强制加一层构建，代价大于收益。FSRS-5 的公式只有十几个，
 * 实现一次可以被单测完全锁定。
 *
 * 与官方实现的差异（只有下面三条，其余逐字对齐）：
 * 1. 关闭 short-term 模式：同一天内重复复习不推进稳定性（记忆增益本来就接近 0）
 * 2. 间隔上限默认 365 天（官方 36500），避免一次「简单」把词推到十年后；
 *    需要严格对齐官方数值时传 opts.maxIvl = 36500
 * 3. 只做「天」粒度：本项目最小复习单位是自然日
 *
 * 对齐验证：test/fsrs.test.mjs 内置官方 FSRS-5 实现跑出的黄金值，
 * 断言本实现与官方误差 < 1e-6。权重来源 ts-fsrs 6.0 的 FSRS5_DEFAULT_WEIGHTS。
 *
 * 公式参考 https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VQFRS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** FSRS-5 官方默认权重 w0..w18（人群均值，不训练即可用） */
  var DEFAULT_W = [
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
    2.9898, 0.51655, 0.6621
  ];

  var DECAY = 0.5;
  var FACTOR = 19 / 81;        // 使 R(t = S) = 0.9
  var R_DESIRED = 0.9;         // 目标保持率
  var S_MIN = 0.01;
  var S_MAX = 36500;
  var D_MIN = 1;
  var D_MAX = 10;
  var MAX_IVL = 365;           // 业务上限（天）

  var GRADES = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
  var GRADE_NAME = { 1: "忘记", 2: "勉强", 3: "记得", 4: "熟练" };

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /** 官方实现每步都做 8 位舍入；不做的话多步累积误差会超出 1e-6 */
  function round8(x) { return Math.round(x * 1e8) / 1e8; }

  /* ================= 遗忘曲线 ================= */

  /** 可提取性：距上次复习过去 elapsed 天，此刻仍记得的概率 */
  function retrievability(elapsed, stability) {
    if (!(stability > 0)) return 0;
    var t = Math.max(0, Number(elapsed) || 0);
    return round8(Math.pow(1 + FACTOR * t / stability, -DECAY));
  }

  /** 稳定性 → 下次复习间隔（天），使届时保持率 ≈ rDesired */
  function intervalFor(stability, rDesired, maxIvl) {
    if (!(stability > 0)) return 1;
    var r = rDesired > 0 && rDesired <= 1 ? rDesired : R_DESIRED;
    var mod = (Math.pow(r, 1 / -DECAY) - 1) / FACTOR;
    var ivl = Math.round(stability * mod);
    var cap = typeof maxIvl === "number" ? maxIvl : MAX_IVL;
    return clamp(ivl, 1, cap);
  }

  /* ================= 初始值 ================= */

  function initStability(grade, w) {
    var W = w || DEFAULT_W;
    return clamp(W[clamp(grade, 1, 4) - 1], S_MIN, S_MAX);
  }

  /** 初始难度：Again ≈ 7.19，Good ≈ 5.28，Easy ≈ 3.22 */
  function initDifficulty(grade, w) {
    var W = w || DEFAULT_W;
    var g = clamp(grade, 1, 4);
    return clamp(round8(W[4] - Math.exp((g - 1) * W[5]) + 1), D_MIN, D_MAX);
  }

  /* ================= 状态更新 ================= */

  /** 难度变化的线性阻尼：越靠近 10 越难再变难（官方 @see fsrs4anki#697） */
  function linearDamping(deltaD, oldD) {
    return round8(deltaD * (10 - oldD) / 9);
  }

  function meanReversion(init, current, w) {
    var W = w || DEFAULT_W;
    return round8(W[7] * init + (1 - W[7]) * current);
  }

  /** 难度更新：答错变难、答对变易，再向「Easy 初始难度」回归一次 */
  function nextDifficulty(d, grade, w) {
    var W = w || DEFAULT_W;
    var g = clamp(grade, 1, 4);
    var deltaD = -W[6] * (g - 3);
    var nextD = d + linearDamping(deltaD, d);
    return clamp(meanReversion(initDifficulty(4, W), nextD, W), D_MIN, D_MAX);
  }

  /** 答对后的稳定性增长 */
  function nextRecallStability(d, s, r, grade, w) {
    var W = w || DEFAULT_W;
    var g = clamp(grade, 1, 4);
    var hardPenalty = g === GRADES.HARD ? W[15] : 1;
    var easyBound = g === GRADES.EASY ? W[16] : 1;
    var inc = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
      (Math.exp((1 - r) * W[10]) - 1) * hardPenalty * easyBound;
    return round8(clamp(s * (1 + inc), S_MIN, S_MAX));
  }

  /** 答错后的稳定性回退 */
  function nextForgetStability(d, s, r, w) {
    var W = w || DEFAULT_W;
    return round8(clamp(
      W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]),
      S_MIN, S_MAX
    ));
  }

  /**
   * 执行一次复习。
   * @param {Object} card  { stability, difficulty, reps, lapses }
   * @param {number} grade 1=Again 2=Hard 3=Good 4=Easy
   * @param {number} elapsed 距上次复习的天数（首次传 0）
   * @param {Object} [opts] { w, maxIvl, rDesired }
   * @returns {{stability,difficulty,reps,lapses,retrievability,interval,isNew}}
   */
  function review(card, grade, elapsed, opts) {
    opts = opts || {};
    var W = opts.w || DEFAULT_W;
    card = card || {};
    var g = clamp(Number(grade) || GRADES.GOOD, 1, 4);
    var reps = Math.max(0, card.reps | 0);
    var s = Number(card.stability) || 0;
    var d = Number(card.difficulty) || 0;
    var lapses = Math.max(0, card.lapses | 0);
    var isNew = reps === 0 || !(s > 0);

    var r, newS, newD;
    if (isNew) {
      r = 0;
      newS = initStability(g, W);
      newD = initDifficulty(g, W);
    } else {
      r = retrievability(elapsed, s);
      newD = nextDifficulty(d, g, W);
      if (g === GRADES.AGAIN) {
        // 官方：答错后稳定性不超过原来（short-term 关闭时 w17*w18 项为 0）
        var failed = nextForgetStability(d, s, r, W);
        newS = clamp(Math.min(s, failed), S_MIN, S_MAX);
      } else {
        newS = nextRecallStability(d, s, r, g, W);
      }
    }
    if (g === GRADES.AGAIN) lapses += 1;

    return {
      stability: newS,
      difficulty: newD,
      reps: reps + 1,
      lapses: lapses,
      retrievability: r,
      interval: intervalFor(newS, opts.rDesired, opts.maxIvl),
      isNew: isNew
    };
  }

  /* ================= 评分推断 ================= */

  /**
   * 把「对 / 错 + 反应时 + 题型」推断成 4 档评分。
   * 反应时是免费的难度信号：又对又快 = 真会，又对又慢 = 刚想起来。
   *
   * 两条保守规则（比 FSRS 默认更严格，理由写在这里免得以后被"优化"掉）：
   * 1. 四选一（match）永远不给 Easy。选项里摆着正确答案，答对只能证明「认得出」，
   *    不能证明「想得起」。识别 ≠ 回忆，给 Easy 会让间隔从 3 天直接跳到 16 天。
   * 2. 新卡第一次不给 Easy。第一次见就判「熟练」几乎一定是偶然，
   *    要连续答对过才够格拉长间隔。
   *
   * @param {boolean} correct
   * @param {string} type  match | spell | listen | produce
   * @param {number} rtMs  反应时（毫秒）
   * @param {boolean} isNew 是否第一次作答
   */
  function gradeOf(correct, type, rtMs, isNew) {
    if (!correct) return GRADES.AGAIN;
    var rt = (Number(rtMs) || 0) / 1000;
    var recallDir = type === "spell" || type === "listen" || type === "produce";
    var slow = rt > 0 && rt >= 12;
    if (!recallDir) return slow ? GRADES.HARD : GRADES.GOOD;  // 四选一上限 Good
    if (isNew) return slow ? GRADES.HARD : GRADES.GOOD;      // 新卡上限 Good
    if (!(rt > 0)) return GRADES.GOOD;                       // 无反应时数据 → 保守
    if (rt <= 9) return GRADES.EASY;                         // 回忆方向答得又快又对
    if (slow) return GRADES.HARD;
    return GRADES.GOOD;
  }

  /** 当前仍记得的概率（首页展示 / 队列排序用） */
  function currentRetrievability(ws, elapsed) {
    if (!ws || !(ws.stability > 0)) return 0;
    return retrievability(elapsed, ws.stability);
  }

  return {
    DEFAULT_W: DEFAULT_W,
    DECAY: DECAY,
    FACTOR: FACTOR,
    R_DESIRED: R_DESIRED,
    MAX_IVL: MAX_IVL,
    GRADES: GRADES,
    GRADE_NAME: GRADE_NAME,
    clamp: clamp,
    retrievability: retrievability,
    intervalFor: intervalFor,
    initStability: initStability,
    initDifficulty: initDifficulty,
    nextDifficulty: nextDifficulty,
    nextRecallStability: nextRecallStability,
    nextForgetStability: nextForgetStability,
    review: review,
    gradeOf: gradeOf,
    currentRetrievability: currentRetrievability
  };
});
