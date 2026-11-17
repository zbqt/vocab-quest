/*!
 * VQEngine — Vocab Quest 纯逻辑层（无 DOM 依赖，浏览器 / Node 双端可用）
 *
 * 设计约束：
 * 1. 本文件不碰 document / window / localStorage，所有函数都是「输入 → 输出」
 * 2. 浏览器里以 window.VQEngine 暴露；Node 里以 module.exports 暴露
 * 3. 记忆调度当前用固定间隔表，后续替换为 FSRS 时只改 nextInterval()
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VQEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ================= 常量 ================= */

  // 连续答对 1/2/3... 次后，下一次复习间隔（天）。第 6 次以后固定 60 天。
  var INTERVALS = [1, 3, 7, 15, 30, 60];
  // 事件日志上限（环形缓冲，防止存档无限膨胀）
  var EVENT_CAP = 2000;
  // 判定「长期记住」：至少 3 个不同自然日答对，且覆盖 ≥2 个题型方向
  var MASTER_DAYS = 3;
  var MASTER_DIRS = 2;
  // 通关线：总题数 × 75%（12 题 → 9 题，14 题 → 11 题）
  var PASS_RATE = 0.75;
  // 题号 → 记忆方向
  var TYPE_DIR = { match: "recog", spell: "recall", listen: "listen", produce: "produce" };

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
      v: 2,
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
      words: {},   // { [lemma]: WordState }
      events: []   // 环形事件日志
    };
  }

  function blankWord(today) {
    return {
      first: today || "",
      seen: 0,
      okDays: [],       // 答对过的自然日（去重）
      dirs: {},         // { recog: "2026-11-17", recall: "..." }
      lapses: 0,        // 答错次数
      streak: 0,        // 连续答对次数
      dueAt: today || "",
      lastOk: "",
      lastWrong: ""
    };
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
    return out;
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
    return s;
  }

  /* ================= 作答记录与记忆状态 ================= */

  function ensureWord(state, word, today) {
    if (!state.words[word]) state.words[word] = blankWord(today);
    return state.words[word];
  }

  function nextInterval(streak) {
    var i = Math.min(Math.max(streak - 1, 0), INTERVALS.length - 1);
    return INTERVALS[i];
  }

  /**
   * 记录一次单词作答（语法题不要调用）。
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

    if (input.correct) {
      ws.streak = (ws.streak || 0) + 1;
      if (ws.okDays.indexOf(today) === -1) ws.okDays.push(today);
      ws.okDays = ws.okDays.slice(-30);
      ws.dirs[dir] = today;
      ws.lastOk = today;
      ws.dueAt = addDays(today, nextInterval(ws.streak));
    } else {
      ws.streak = 0;
      ws.lapses = (ws.lapses || 0) + 1;
      ws.lastWrong = today;
      ws.dueAt = today; // 当天就要重学
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
      arr.push({ word: w, ws: ws, rescue: inRescue(ws) });
    });
    arr.sort(function (a, b) {
      if (a.rescue !== b.rescue) return a.rescue ? -1 : 1;
      var d = diffDays(b.ws.dueAt, a.ws.dueAt); // 到期越久越靠前
      if (d !== 0) return d;
      return (b.ws.lapses || 0) - (a.ws.lapses || 0);
    });
    return typeof limit === "number" ? arr.slice(0, limit) : arr;
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

    if (spellEvery > 0 && (index + 1) % spellEvery === 0) {
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
      return buildQuestion(w, i, { rng: rng, spellEvery: spellEvery, pool: pool });
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
    INTERVALS: INTERVALS,
    EVENT_CAP: EVENT_CAP,
    MASTER_DAYS: MASTER_DAYS,
    MASTER_DIRS: MASTER_DIRS,
    dayKey: dayKey,
    addDays: addDays,
    diffDays: diffDays,
    blankPass: blankPass,
    validPass: validPass,
    countPassedMap: countPassedMap,
    createState: createState,
    normalizeState: normalizeState,
    sanitizeWord: sanitizeWord,
    recordAnswer: recordAnswer,
    isLongTerm: isLongTerm,
    inRescue: inRescue,
    counts: counts,
    dueList: dueList,
    passNeedFor: passNeedFor,
    starsFor: starsFor,
    buildQuestion: buildQuestion,
    buildSession: buildSession,
    appendEvent: appendEvent,
    seededShuffle: seededShuffle,
    nextInterval: nextInterval
  };
});
