/*!
 * VQEngine — Vocab Quest 纯逻辑层（无 DOM 依赖，浏览器 / Node 双端可用）
 *
 * 设计约束：
 * 1. 本文件不碰 document / window / localStorage，所有函数都是「输入 → 输出」
 * 2. 浏览器里以 window.VQEngine 暴露；Node 里以 module.exports 暴露
 * 3. 记忆调度交给 fsrs.js（FSRS-5），本文件只负责存档模型、掌握判定、队列组装
 *
 * 浏览器加载顺序：fsrs.js 必须在 engine.js 之前
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./fsrs.js"));
  } else {
    root.VQEngine = factory(root.VQFRS);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (FRS) {
  "use strict";

  if (!FRS) throw new Error("VQEngine 依赖 fsrs.js，请先加载 fsrs.js");

  /* ================= 常量 ================= */

  // 事件日志上限（环形缓冲，防止存档无限膨胀）
  var EVENT_CAP = 2000;
  // 判定「长期记住」：至少 3 个不同自然日答对，且覆盖 ≥2 个题型方向
  var MASTER_DAYS = 3;
  var MASTER_DIRS = 2;
  // 通关线：总题数 × 75%（12 题 → 9 题，14 题 → 11 题）
  var PASS_RATE = 0.75;
  // 题号 → 记忆方向
  var TYPE_DIR = { match: "recog", spell: "recall", listen: "listen", produce: "produce" };
  // 每日队列：总词数上限 / 新词保底 / 新词上限
  // 保底是为了「每天都有新内容」，上限是为了「一天别全是生词」
  var DAILY_TOTAL = 20;
  var DAILY_NEW = 15;
  var DAILY_NEW_FLOOR = 8;
  // 定级测试默认：6 层 × 7 题 = 42 题，约 3 分钟
  var PLACEMENT_BANDS = 6;
  var PLACEMENT_PER_BAND = 7;
  // 定级结果只跳过估算值的这个比例，留出缓冲防高估
  var PLACEMENT_CONFIDENCE = 0.8;
  // 每题平均耗时（秒），用于「今天要花多久」的预估
  var SEC_PER_WORD = 12;

  /* ================= 日期工具（统一用 YYYY-M-D 的本地日，不碰时区） ================= */

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function dayKey(input) {
    if (typeof input === "string" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(input)) {
      var p = input.split("-");
      return p[0] + "-" + (+p[1]) + "-" + (+p[2]);
    }
    var d = input instanceof Date ? input : new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function toUTC(key) {
    var p = String(key).split("-");
    return Date.UTC(+p[0], (+p[1]) - 1, +p[2]);
  }

  function addDays(key, n) {
    var d = new Date(toUTC(key) + n * 86400000);
    return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();
  }

  function diffDays(a, b) { return Math.round((toUTC(b) - toUTC(a)) / 86400000); }

  /* ================= 存档结构 ================= */

  function blankPass(units) {
    var p = {};
    (units || []).forEach(function (u) {
      p[u.id] = {};
      for (var l = 1; l <= u.levels; l++) p[u.id][l] = 0;
    });
    return p;
  }

  function validPass(p, units) {
    if (!p || typeof p !== "object") return false;
    for (var i = 0; i < units.length; i++) {
      var u = units[i], q = p[u.id];
      if (!q || typeof q !== "object") return false;
      for (var l = 1; l <= u.levels; l++) if (typeof q[l] !== "number") return false;
    }
    return true;
  }

  function countPassedMap(p, units) {
    var n = 0;
    (units || []).forEach(function (u) {
      for (var l = 1; l <= u.levels; l++) if (p && p[u.id] && p[u.id][l] > 0) n++;
    });
    return n;
  }

  function createState(units, today) {
    today = today || dayKey(new Date());
    return {
      v: 3,
      hp: 3,
      lv: 7,
      coin: 1280,
      exp: 0,
      reviewed: 0,
      shufMode: false,
      lastReviewDate: "",
      passedCount: 0,
      passedCountS: 0,
      passed: blankPass(units),
      passedS: blankPass(units),
      words: {},        // { [lemma]: WordState }
      days: [],         // 有学习行为的自然日（算连续天数）
      placement: null,  // { at, estimate, bands, levels }
      lastDailyDate: "", // 上次完成「今天 N 词」的日期
      lastDailyCount: 0,
      events: [],       // 环形事件日志
      gSeen: {}         // 语法题做过记录 {题干: 时间戳}，用于优先出没做过的题
    };
  }

  function blankWord(today) {
    return {
      first: today || "",
      seen: 0,
      okDays: [],       // 答对过的自然日（去重）
      dirs: {},         // { recog: "2026-11-17", recall: "..." }
      lapses: 0,        // 遗忘次数（FSRS Again 次数）
      streak: 0,        // 连续答对次数（错词区毕业判定用）
      dueAt: today || "",
      lastOk: "",
      lastWrong: "",
      lastReview: "",   // 上次复习日（算 FSRS 的 elapsed）
      s: 0,             // FSRS 稳定性（天）
      d: 0,             // FSRS 难度（1~10）
      reps: 0,          // FSRS 复习次数
      lastGrade: 0,     // 上次评分 1~4
      placed: false     // 是否由定级测试判为「已会」（仍会被复习验证）
    };
  }

  function num(x, def) {
    var n = Number(x);
    return isFinite(n) ? n : (def || 0);
  }

  function sanitizeWord(ws, today) {
    var out = blankWord(today);
    if (!ws || typeof ws !== "object") return out;
    out.first = typeof ws.first === "string" ? dayKey(ws.first) : (today || "");
    out.seen = Math.max(0, ws.seen | 0);
    out.okDays = Array.isArray(ws.okDays) ? ws.okDays.filter(function (d) {
      return typeof d === "string" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(d);
    }).map(dayKey).slice(-30) : [];
    out.dirs = {};
    if (ws.dirs && typeof ws.dirs === "object") {
      Object.keys(ws.dirs).forEach(function (k) {
        if (typeof ws.dirs[k] === "string" && ws.dirs[k]) out.dirs[k] = dayKey(ws.dirs[k]);
      });
    }
    out.lapses = Math.max(0, ws.lapses | 0);
    out.streak = Math.max(0, ws.streak | 0);
    out.dueAt = typeof ws.dueAt === "string" && ws.dueAt ? dayKey(ws.dueAt) : (today || "");
    out.lastOk = typeof ws.lastOk === "string" ? ws.lastOk : "";
    out.lastWrong = typeof ws.lastWrong === "string" ? ws.lastWrong : "";
    out.lastReview = typeof ws.lastReview === "string" ? ws.lastReview : "";
    out.s = Math.max(0, num(ws.s));
    out.d = Math.max(0, num(ws.d));
    out.reps = Math.max(0, ws.reps | 0);
    out.lastGrade = Math.max(0, Math.min(4, ws.lastGrade | 0));
    out.placed = !!ws.placed;
    // 一致性：有 s 但没 reps 视为 1 次；有 reps 但没 s 视为坏档，清零重算
    if (out.s > 0 && out.reps === 0) out.reps = 1;
    if (out.reps > 0 && !(out.s > 0)) { out.reps = 0; out.d = 0; out.placed = false; }
    return out;
  }

  /**
   * 旧版本存档没有 FSRS 参数：按「见过但未形成长期记忆」补一个保守初值，
   * 而不是清零——否则老用户的复习进度会全部丢失。
   * 必须是幂等的：已经补过的词再跑一次不该变化。
   */
  function backfillFSRS(ws) {
    if (!ws) return ws;
    if ((ws.reps || 0) > 0) return ws;
    if ((ws.seen || 0) > 0 || (ws.lapses || 0) > 0) {
      ws.reps = Math.max(1, ws.seen || 0);
      ws.s = ws.streak > 0 ? Math.min(15, 1.5 * ws.streak) : 1;
      ws.d = 5;
    }
    return ws;
  }

  /**
   * 存档归一化 + 旧存档迁移。
   * 旧版两处不诚实的数据在这里被「清零重算」：
   *  - masteredWords（答对一次即掌握）→ 只建条目，不给 okDays，因此不计入长期掌握
   *  - rescue: ["word"]（只进不出）→ 转为带 streak / dueAt 的词状态
   */
  function normalizeState(raw, opts) {
    opts = opts || {};
    var units = opts.units || [];
    var today = dayKey(opts.today || new Date());
    var bank = opts.bank ? (opts.bank instanceof Set ? opts.bank : new Set(opts.bank)) : null;
    var s = createState(units, today);
    if (!raw || typeof raw !== "object") return s;

    ["hp", "lv", "coin", "exp", "reviewed", "shufMode"].forEach(function (k) {
      if (raw[k] !== undefined && typeof raw[k] === typeof s[k]) s[k] = raw[k];
    });
    if (typeof raw.lastReviewDate === "string") s.lastReviewDate = raw.lastReviewDate;
    if (typeof raw.lastDailyDate === "string") s.lastDailyDate = raw.lastDailyDate;
    if (typeof raw.lastDailyCount === "number") s.lastDailyCount = Math.max(0, raw.lastDailyCount | 0);

    // 连续学习天数：只保留合法日期，去重排序
    if (Array.isArray(raw.days)) {
      var seenDay = {};
      s.days = raw.days.filter(function (d) {
        if (typeof d !== "string" || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) return false;
        var k = dayKey(d);
        if (seenDay[k]) return false;
        seenDay[k] = 1;
        return true;
      }).map(dayKey).sort().slice(-400);
    }
    // 定级结果：只保留展示与排序需要的部分（掌握率决定新词学习顺序）
    if (raw.placement && typeof raw.placement === "object" && typeof raw.placement.estimate === "number") {
      s.placement = {
        at: typeof raw.placement.at === "string" ? raw.placement.at : "",
        estimate: Math.max(0, Math.floor(raw.placement.estimate)),
        levels: Math.max(0, raw.placement.levels | 0),
        skipped: Math.max(0, raw.placement.skipped | 0),
        bands: Array.isArray(raw.placement.bands) ? raw.placement.bands.slice(0, 20).map(function (b) {
          return {
            band: Math.max(1, b && b.band | 0),
            asked: Math.max(0, b && b.asked | 0),
            ok: Math.max(0, b && b.ok | 0),
            rate: Math.max(0, Math.min(1, num(b && b.rate))),
            trueRate: Math.max(0, Math.min(1, num(b && b.trueRate)))
          };
        }) : []
      };
    }

    if (validPass(raw.passed, units)) s.passed = raw.passed;
    if (validPass(raw.passedS, units)) s.passedS = raw.passedS;
    s.passedCount = countPassedMap(s.passed, units);
    s.passedCountS = countPassedMap(s.passedS, units);

    if (raw.words && typeof raw.words === "object") {
      Object.keys(raw.words).forEach(function (w) {
        if (bank && !bank.has(w)) return;
        s.words[w] = sanitizeWord(raw.words[w], today);
      });
    }

    // 旧版：已掌握词表 → 仅保留「见过」痕迹，不冒充长期记忆
    if (Array.isArray(raw.masteredWords)) {
      raw.masteredWords.forEach(function (w) {
        if (typeof w !== "string") return;
        if (bank && !bank.has(w)) return;
        if (!s.words[w]) {
          var ws = blankWord("");
          ws.first = "";
          s.words[w] = ws;
        }
      });
    }

    // 旧版：急救包字符串数组 → 带状态的错词（streak=0，当天到期）
    if (Array.isArray(raw.rescue)) {
      raw.rescue.forEach(function (item) {
        var w = typeof item === "string" ? item : (item && item.w);
        if (typeof w !== "string" || !w) return;
        if (bank && !bank.has(w)) return;
        var ws = s.words[w] || (s.words[w] = blankWord(today));
        ws.lapses = Math.max(1, ws.lapses || 0);
        ws.streak = 0;
        ws.dueAt = today;
      });
    }

    if (Array.isArray(raw.events)) {
      s.events = raw.events.filter(function (e) { return e && typeof e === "object"; }).slice(-EVENT_CAP);
    }

    // 语法题做题记录：保留最近 300 条，用于「优先出没做过的题」
    if (raw.gSeen && typeof raw.gSeen === "object") {
      var gs = {};
      Object.keys(raw.gSeen)
        .filter(function (k) { return typeof raw.gSeen[k] === "number" && raw.gSeen[k] > 0; })
        .sort(function (a, b) { return raw.gSeen[b] - raw.gSeen[a]; })
        .slice(0, 300)
        .forEach(function (k) { gs[String(k).slice(0, 300)] = raw.gSeen[k]; });
      s.gSeen = gs;
    }
    // 统一补 FSRS 参数（放在最后，保证 rescue 迁移出来的词也能补到）
    Object.keys(s.words).forEach(function (w) { backfillFSRS(s.words[w]); });
    return s;
  }

  /* ================= 作答记录与记忆状态 ================= */

  function ensureWord(state, word, today) {
    if (!state.words[word]) state.words[word] = blankWord(today);
    return state.words[word];
  }

  /** 记一次「今天有学习」——连续天数与留存指标都从这里来 */
  function markDay(state, today) {
    state.days = state.days || [];
    if (state.days.indexOf(today) === -1) {
      state.days.push(today);
      state.days.sort();
      if (state.days.length > 400) state.days = state.days.slice(-400);
    }
    return state.days;
  }

  /**
   * 记录一次单词作答（语法题不要调用）。
   *
   * 调度交给 FSRS：由「评分 + 距上次复习的天数」推出新的稳定性与难度，
   * 到期日 = 今天 + 间隔。评分从对错、反应时、题型推出来（见 fsrs.gradeOf）。
   *
   * @returns {WordState}
   */
  function recordAnswer(state, input) {
    var word = input && input.word;
    if (!word) return null;
    var today = dayKey(input.today || new Date());
    var dir = TYPE_DIR[input.type] || "recog";
    var ws = ensureWord(state, word, today);
    if (!ws.first) ws.first = today;
    ws.seen = (ws.seen || 0) + 1;
    markDay(state, today);

    // 记忆侧：FSRS 主状态
    var grade = FRS.gradeOf(!!input.correct, input.type, input.rt, (ws.reps || 0) === 0);
    var elapsed = ws.lastReview ? Math.max(0, diffDays(ws.lastReview, today)) : 0;
    var res = FRS.review(
      { stability: ws.s || 0, difficulty: ws.d || 0, reps: ws.reps || 0, lapses: ws.lapses || 0 },
      grade, elapsed, { maxIvl: typeof input.maxIvl === "number" ? input.maxIvl : FRS.MAX_IVL }
    );
    ws.s = res.stability;
    ws.d = res.difficulty;
    ws.reps = res.reps;
    ws.lapses = res.lapses;
    ws.lastGrade = grade;
    ws.lastReview = today;
    // 答错的词当天就回到队列（能马上重练），答对的才按 FSRS 的间隔排期。
    // FSRS 的 Again 本身只给 1 天，但本产品没有「10 分钟后」这种分钟级调度，
    // 错词当天可见是复习体验的底线。
    ws.dueAt = grade === FRS.GRADES.AGAIN ? today : addDays(today, res.interval);

    // 展示侧：连续天数、答对日、题型方向（掌握判定用）
    if (input.correct) {
      ws.streak = (ws.streak || 0) + 1;
      if (ws.okDays.indexOf(today) === -1) ws.okDays.push(today);
      ws.okDays = ws.okDays.slice(-30);
      ws.dirs[dir] = today;
      ws.lastOk = today;
    } else {
      ws.streak = 0;
      ws.lastWrong = today;
    }
    return ws;
  }

  /** 长期记忆：≥3 个不同自然日答对 + ≥2 个方向 + 最近一次不是错 */
  function isLongTerm(ws) {
    if (!ws) return false;
    var days = (ws.okDays || []).slice().sort();
    if (days.length < MASTER_DAYS) return false;
    var dirs = Object.keys(ws.dirs || {}).filter(function (k) { return !!ws.dirs[k]; }).length;
    if (dirs < MASTER_DIRS) return false;
    if (diffDays(days[0], days[days.length - 1]) < MASTER_DAYS - 1) return false;
    // 最近一次错在最近一次对之后 → 记忆已失效
    if (ws.lastWrong && ws.lastOk && diffDays(ws.lastOk, ws.lastWrong) > 0) return false;
    return true;
  }

  /** 错词巩固区：错过且还没连续答对 2 次 */
  function inRescue(ws) {
    if (!ws) return false;
    return (ws.lapses || 0) > 0 && (ws.streak || 0) < 2;
  }

  function counts(state) {
    var mastered = 0, learning = 0, rescue = 0, seen = 0;
    Object.keys(state.words || {}).forEach(function (w) {
      var ws = state.words[w];
      if (!ws) return;
      var touched = (ws.seen || 0) > 0 || (ws.lapses || 0) > 0 || (ws.okDays || []).length > 0;
      if (!touched) return;
      seen++;
      if (isLongTerm(ws)) mastered++;
      else learning++;
      if (inRescue(ws)) rescue++;
    });
    return { mastered: mastered, learning: learning, rescue: rescue, seen: seen };
  }

  /** 到期队列：错词优先 → 到期早的优先 → 错得多的优先 */
  function dueList(state, today, limit) {
    today = dayKey(today || new Date());
    var arr = [];
    Object.keys(state.words || {}).forEach(function (w) {
      var ws = state.words[w];
      if (!ws || !ws.dueAt) return;
      if (diffDays(ws.dueAt, today) < 0) return; // 还没到期
      arr.push({
        word: w,
        ws: ws,
        rescue: inRescue(ws),
        r: FRS.currentRetrievability(ws, Math.max(0, diffDays(ws.lastReview || ws.dueAt, today)))
      });
    });
    arr.sort(function (a, b) {
      if (a.rescue !== b.rescue) return a.rescue ? -1 : 1;
      var d = diffDays(b.ws.dueAt, a.ws.dueAt); // 到期越久越靠前
      if (d !== 0) return d;
      return (b.ws.lapses || 0) - (a.ws.lapses || 0);
    });
    return typeof limit === "number" ? arr.slice(0, limit) : arr;
  }

  /* ================= 今日队列 ================= */

  /** 两组交替排列（保持各自原有顺序） */
  function interleaveDaily(a, b) {
    var out = [], i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length) out.push(a[i++]);
      if (j < b.length) out.push(b[j++]);
    }
    return out;
  }

  /**
   * 今日队列：「今天该学什么」只有一个答案。
   *
   * 组成：错词（最急）→ 其余到期复习 → 新词，复习与新词交替排。
   * 新词严格按传入的 order 顺序取，已学过或已被定级跳过的词自动略过，
   * 所以不会重复发新词。
   *
   * @param {Object} state
   * @param {Object} opts { today, total, newMax, newFloor, order }
   * @returns {{words:Array, reviewCount:number, newCount:number,
   *            dueCount:number, total:number, remainingNew:number,
   *            daysToFinish:number, minutes:number}}
   */
  function dailyQueue(state, opts) {
    opts = opts || {};
    var today = dayKey(opts.today || new Date());
    var total = opts.total > 0 ? opts.total : DAILY_TOTAL;
    var newMax = opts.newMax == null ? DAILY_NEW : Math.max(0, opts.newMax | 0);
    var newFloor = opts.newFloor == null ? DAILY_NEW_FLOOR : Math.max(0, opts.newFloor | 0);
    var order = opts.order || [];

    var dueAll = dueList(state, today);
    // 复习最多占到「总数 - 新词保底」，剩下的名额留给新词
    var reviewCap = Math.max(0, total - Math.min(newFloor, total));
    var reviews = dueAll.slice(0, reviewCap).map(function (x) {
      return { word: x.word, isNew: false, rescue: !!x.rescue, dueAt: x.ws.dueAt, r: x.r };
    });

    // 新词：按 order 顺序取还没学过的，补满剩余名额（不超过新词上限）
    var unseenLeft = 0, fresh = [];
    var freshCap = Math.min(newMax, Math.max(0, total - reviews.length));
    for (var i = 0; i < order.length; i++) {
      var w = order[i], ws = state.words[w];
      var studied = !!ws && ((ws.seen || 0) > 0 || (ws.reps || 0) > 0);
      if (studied) continue;
      unseenLeft++;
      if (fresh.length < freshCap) fresh.push({ word: w, isNew: true, rescue: false, dueAt: "", r: 0 });
    }

    var urgent = reviews.filter(function (x) { return x.rescue; });
    var rest = reviews.filter(function (x) { return !x.rescue; });
    var words = urgent.concat(interleaveDaily(rest, fresh));

    return {
      words: words,
      reviewCount: reviews.length,
      newCount: fresh.length,
      dueCount: dueAll.length,
      total: words.length,
      remainingNew: unseenLeft,
      daysToFinish: newMax > 0 ? Math.ceil(unseenLeft / newMax) : 0,
      minutes: Math.max(1, Math.round(words.length * SEC_PER_WORD / 60))
    };
  }

  /** 连续学习天数（今天还没学但昨天学了，连续记录不中断） */
  function streakDays(state, today) {
    today = dayKey(today || new Date());
    var days = (state.days || []).slice();
    if (!days.length) return 0;
    var set = {};
    days.forEach(function (d) { set[d] = 1; });
    var cursor = set[today] ? today : addDays(today, -1);
    var n = 0;
    while (set[cursor]) {
      n++;
      cursor = addDays(cursor, -1);
      if (n > 400) break;
    }
    return n;
  }

  /* ================= 定级测试 ================= */

  /**
   * 生成定级题目：把词库按「由常用到生僻」分层，每层随机抽几题。
   * 分层抽样才估得准——只考开头几个词会高估，只考末尾会低估。
   *
   * @param {Array} bank 词库 [[en, zh, ph], ...]，顺序即由易到难
   * @param {Object} opts { bands, perBand, rng }
   */
  function placementPlan(bank, opts) {
    opts = opts || {};
    var bands = Math.max(1, opts.bands || PLACEMENT_BANDS);
    var perBand = Math.max(1, opts.perBand || PLACEMENT_PER_BAND);
    var rng = opts.rng || defaultRng;
    var n = (bank || []).length;
    if (!n) return { questions: [], bands: bands, size: 0 };

    var width = n / bands;
    var qs = [];
    for (var i = 0; i < bands; i++) {
      var start = Math.floor(i * width);
      var end = i === bands - 1 ? n : Math.floor((i + 1) * width);
      if (end <= start) continue;
      var slice = bank.slice(start, end);
      rng(slice).slice(0, perBand).forEach(function (w) {
        qs.push(makePlacementQ(w, bank, i + 1, rng));
      });
    }
    return { questions: rng(qs), bands: bands, size: n };
  }

  function makePlacementQ(word, bank, band, rng) {
    var en = word[0], zh = word[1];
    var used = {}, distractors = [];
    used[zh] = 1;
    var pool = rng(bank || []);
    for (var i = 0; i < pool.length && distractors.length < 3; i++) {
      var z = pool[i][1];
      if (!z || used[z] || pool[i][0] === en) continue; // 释义重复会让题目有两个正确答案
      used[z] = 1;
      distractors.push(z);
    }
    return {
      type: "place", en: en, zh: zh, ph: word[2] || "",
      band: band, prompt: en, answer: zh,
      options: rng([zh].concat(distractors))
    };
  }

  /**
   * 结算定级结果。
   * 每层正确率先扣掉四选一的猜测率（25%），再按层宽加权求和。
   *
   * @param {Array} answers [{ band, word, correct }]
   * @param {Object} meta placementPlan 的返回值（需要 bands / size）
   * @param {Object} opts { confidence }
   * @returns {{estimate, skip, bands, asked, correct, known}}
   */
  function placementResult(answers, meta, opts) {
    opts = opts || {};
    meta = meta || {};
    var bands = Math.max(1, meta.bands || PLACEMENT_BANDS);
    var size = Math.max(0, meta.size || 0);
    var width = size / bands;
    var list = (answers || []).filter(function (a) { return a && a.band >= 1; });

    var rows = [], est = 0, asked = 0, correct = 0, known = [];
    for (var i = 1; i <= bands; i++) {
      var inBand = list.filter(function (a) { return a.band === i; });
      var ok = inBand.filter(function (a) { return a.correct; }).length;
      var rate = inBand.length ? ok / inBand.length : 0;
      // 四选一：随机蒙对概率 0.25，扣掉后才接近真实掌握率
      var trueRate = Math.max(0, (rate - 0.25) / 0.75);
      rows.push({ band: i, asked: inBand.length, ok: ok, rate: rate, trueRate: trueRate });
      est += width * trueRate;
      asked += inBand.length;
      correct += ok;
    }
    list.forEach(function (a) {
      if (a.correct && typeof a.word === "string" && a.word) known.push(a.word);
    });

    var estimate = Math.round(Math.max(0, Math.min(size, est)));
    var confidence = typeof opts.confidence === "number" ? opts.confidence : PLACEMENT_CONFIDENCE;
    return {
      estimate: estimate,
      skip: known.length,
      bands: rows,
      asked: asked,
      correct: correct,
      known: known,
      confidence: confidence,
      size: size
    };
  }

  /**
   * 应用定级结果。
   *
   * 只做两件不冒险的事：
   * 1. 答对的词标记为「定级跳过」（placed），60 天后进复习队列被验证一次。
   *    如果那时发现其实不会，就会答错、回到正常流程——高估会被自动纠正。
   * 2. 记录每层掌握率，用来决定新词的学习顺序（最不熟的区间先学）。
   *
   * 刻意不做「跳过前 N 个词」：词库是字母序而不是难度序，
   * 认识 might 不代表认识 abandon，按位置跳过会大面积漏词。
   */
  function applyPlacement(state, result, opts) {
    opts = opts || {};
    var today = dayKey(opts.today || new Date());
    var verifyIn = opts.verifyIn || 60;
    result = result || {};
    (result.known || []).forEach(function (w) {
      if (!w) return;
      var ws = state.words[w] || (state.words[w] = blankWord(today));
      if ((ws.reps || 0) > 0) return;   // 已经学过的词不动
      ws.placed = true;
      ws.reps = 1;
      ws.s = 20;
      ws.d = 3;
      ws.seen = Math.max(1, ws.seen || 0);
      ws.dueAt = addDays(today, verifyIn);
      ws.first = ws.first || today;
    });
    state.placement = {
      at: today,
      estimate: Math.max(0, result.estimate | 0),
      levels: (result.bands || []).length,
      skipped: (result.known || []).length,
      bands: result.bands || []
    };
    return state.placement;
  }

  /**
   * 新词学习顺序：按分层掌握率升序（最不熟的词库区间先学），
   * 同层内保持词库原有顺序。定级测出来的是「哪一段最生」，
   * 不是「前 N 个词都会」，所以只能调顺序，不能砍词。
   */
  function learnOrder(bank, placement) {
    var list = bank || [];
    var bands = placement && placement.bands;
    if (!bands || !bands.length || !list.length) return list.slice();
    var n = list.length, b = bands.length;
    var width = n / b;
    var rate = {};
    bands.forEach(function (x) { if (x && x.band) rate[x.band] = x.trueRate || 0; });

    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    idx.sort(function (x, y) {
      var bx = Math.min(b, Math.floor(x / width) + 1);
      var by = Math.min(b, Math.floor(y / width) + 1);
      var rx = rate[bx] == null ? 0 : rate[bx];
      var ry = rate[by] == null ? 0 : rate[by];
      if (rx !== ry) return rx - ry;
      return x - y;
    });
    return idx.map(function (i) { return list[i]; });
  }

  /**
   * 用户手动声明「这词我会」。
   *
   * 和定级跳过共用同一套逻辑：不当成真会，而是推到 N 天后抽查一次。
   * 抽查时答错就回到正常流程，所以误点也不会造成漏词。
   */
  function markKnown(state, word, opts) {
    opts = opts || {};
    var today = dayKey(opts.today || new Date());
    if (!word || !state || !state.words) return null;
    var ws = state.words[word] || (state.words[word] = blankWord(today));
    ws.placed = true;
    ws.reps = Math.max(1, ws.reps || 0);
    ws.s = Math.max(20, ws.s || 0);      // 稳定性至少 20 天，避免明天就回来
    ws.d = 3;
    ws.seen = Math.max(1, ws.seen || 0);
    ws.first = ws.first || today;
    ws.lastReview = today;
    ws.lastGrade = FRS.GRADES.EASY;
    ws.dueAt = addDays(today, opts.verifyIn || 60);
    return ws;
  }

  /* ================= 评分 ================= */

  function passNeedFor(total) { return total > 0 ? Math.ceil(total * PASS_RATE) : 0; }

  /** 答满全部题目后才调用；答对率不足通关线返回 0 星（未通关） */
  function starsFor(correct, total) {
    if (!total || total <= 0) return 0;
    if (correct >= total) return 3;      // 全对
    if (correct >= total - 1) return 2;  // 只错一题
    if (correct >= passNeedFor(total)) return 1;
    return 0;
  }

  /* ================= 出题 ================= */

  function buildQuestion(word, index, opts) {
    opts = opts || {};
    var en = word[0], zh = word[1], ph = word[2] || "";
    var rng = opts.rng || defaultRng;
    var spellEvery = opts.spellEvery || 0;
    var pool = opts.pool || [];

    // forceType 优先：每日队列里新词只考识别、复习词才考拼写
    var wantSpell = opts.forceType
      ? opts.forceType === "spell"
      : (spellEvery > 0 && (index + 1) % spellEvery === 0);

    if (wantSpell) {
      return {
        type: "spell",
        en: en, zh: zh, ph: ph,
        prompt: en.replace(/[aeiou]/gi, "_") + "（" + zh + "）",
        answer: en
      };
    }
    var others = rng(pool.filter(function (w) { return w[0] !== en; }))
      .slice(0, 3).map(function (w) { return w[0]; });
    var options = rng([en].concat(others));
    return {
      type: "match",
      en: en, zh: zh, ph: ph,
      prompt: zh,
      answer: en,
      options: options,
      optDefs: options.map(function (o) {
        var f = null;
        for (var i = 0; i < pool.length; i++) if (pool[i][0] === o) { f = pool[i]; break; }
        return { en: o, zh: f ? f[1] : "", ph: f ? f[2] || "" : "" };
      })
    };
  }

  /**
   * 组装一局：本关每个单词都必考一次（不再是 12 词只考 10 题），
   * 语法题叠加在单词题之上，总题数 = 词数 + 语法题数。
   */
  function buildSession(input) {
    input = input || {};
    var words = input.words || [];
    var rng = input.rng || defaultRng;
    var mode = input.mode || "play";
    var spellEvery = input.spellEvery || 0;
    var grammarN = Math.min(input.grammarN || 0, (input.grammar || []).length);
    var pool = input.pool || words;

    var wordQs = words.map(function (w, i) {
      var forced = input.wordTypes && input.wordTypes[i];
      return buildQuestion(w, i, { rng: rng, spellEvery: spellEvery, pool: pool, forceType: forced });
    });

    var gPool = rng((input.grammar || []).slice());
    var gQs = [];
    var used = {};
    for (var i = 0; i < gPool.length && gQs.length < grammarN; i++) {
      var g = gPool[i];
      if (!g || used[g.q]) continue;
      used[g.q] = 1;
      gQs.push({
        type: "grammar",
        prompt: g.q,
        answer: g.a,
        options: rng(g.options.slice()),
        tip: g.tip || ""
      });
    }

    var questions = interleave(wordQs, gQs, wordQs.length + gQs.length, rng);
    var total = questions.length;
    return { questions: questions, total: total, passNeed: passNeedFor(total), mode: mode };
  }

  function interleave(wordQs, gQs, total, rng) {
    rng = rng || defaultRng;
    var out = wordQs.slice();
    // 从高到低插入，保证前面的插入不会让后面的下标错位
    var slots = rng(out.map(function (_, i) { return i; })).slice(0, gQs.length).sort(function (a, b) { return b - a; });
    gQs.forEach(function (g, i) { out.splice(slots[i], 0, g); });
    return out;
  }

  /* ================= 事件日志 ================= */

  function appendEvent(state, ev, cap) {
    cap = cap || EVENT_CAP;
    var e = {};
    Object.keys(ev || {}).forEach(function (k) { if (ev[k] !== undefined) e[k] = ev[k]; });
    if (!e.ts) e.ts = Date.now();
    state.events = state.events || [];
    state.events.push(e);
    if (state.events.length > cap) state.events.splice(0, state.events.length - cap);
    return e;
  }

  /* ================= 其它 ================= */

  function defaultRng(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** 固定种子洗牌：用于乱序题库，保证每次打开分组一致 */
  function seededShuffle(arr, seed) {
    var a = arr.slice(), s = seed | 0;
    function rnd() {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    for (var i = a.length - 1; i > 0; i--) {
      var j = rnd() * (i + 1) | 0;
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  return {
    EVENT_CAP: EVENT_CAP,
    MASTER_DAYS: MASTER_DAYS,
    MASTER_DIRS: MASTER_DIRS,
    DAILY_TOTAL: DAILY_TOTAL,
    DAILY_NEW: DAILY_NEW,
    DAILY_NEW_FLOOR: DAILY_NEW_FLOOR,
    PLACEMENT_BANDS: PLACEMENT_BANDS,
    PLACEMENT_PER_BAND: PLACEMENT_PER_BAND,
    PLACEMENT_CONFIDENCE: PLACEMENT_CONFIDENCE,
    FRS: FRS,
    dayKey: dayKey,
    addDays: addDays,
    diffDays: diffDays,
    blankPass: blankPass,
    validPass: validPass,
    countPassedMap: countPassedMap,
    createState: createState,
    normalizeState: normalizeState,
    sanitizeWord: sanitizeWord,
    markDay: markDay,
    recordAnswer: recordAnswer,
    isLongTerm: isLongTerm,
    inRescue: inRescue,
    counts: counts,
    dueList: dueList,
    dailyQueue: dailyQueue,
    streakDays: streakDays,
    placementPlan: placementPlan,
    placementResult: placementResult,
    applyPlacement: applyPlacement,
    markKnown: markKnown,
    learnOrder: learnOrder,
    passNeedFor: passNeedFor,
    starsFor: starsFor,
    buildQuestion: buildQuestion,
    buildSession: buildSession,
    appendEvent: appendEvent,
    seededShuffle: seededShuffle
  };
});
