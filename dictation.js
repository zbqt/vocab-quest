/*!
 * VQDictation —— 听写判分（纯函数，不碰 DOM，浏览器 / Node 双端可用）
 *
 * 听写最怕判得不公平：
 *   - 大小写、句末句号、逗号不该算错 → 归一化时抹掉
 *   - don't / dont 是同一个词 → 抹掉撇号
 *   - check-in / check in 是同一个词 → 连字符当空格
 *   - 多写一个词不该把后面的词全判错 → 用最长公共子序列对齐，不是逐位比
 *
 * 只做「对/错/漏/多」四件事，不给分数以外的评价。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VQDictation = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 数字与英文数词互认：听到 "two"，写 2 也算对。
  // 只收 1~12 这种「一个词就是一个数」的情况 —— twenty 之类会跟 eight 组成复合数，
  // 逐词映射反而会把 "thirty eight" 拆成 "30 8"，比不映射更难对齐。
  var NUM = {
    one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
    eleven: "11", twelve: "12",
    first: "1st", second: "2nd", third: "3rd"
  };

  /**
   * 句子 → 可比较的词数组。
   * 归一化只抹掉「听不出来」的差异，不抹掉真正的错词。
   */
  function normalizeWords(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[\u2018\u2019']/g, "")      // don't → dont
      .replace(/[-\u2013\u2014]/g, " ")     // check-in → check in
      .replace(/[^a-z0-9\s]/g, " ")         // 标点全部抹掉（听写不判标点）
      .split(/\s+/)
      .filter(Boolean)
      .map(function (w) { return NUM[w] || w; });
  }

  /**
   * 词级对齐：最长公共子序列。
   * 逐位比会把「漏了一个词」变成「后面全错」，那样反馈毫无意义。
   */
  function align(expected, got) {
    var n = expected.length, m = got.length;
    var dp = [];
    for (var a = 0; a <= n; a++) {
      var row = new Array(m + 1);
      for (var b = 0; b <= m; b++) row[b] = 0;
      dp.push(row);
    }
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        dp[i][j] = expected[i - 1] === got[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    var tokens = [];
    var x = n, y = m;
    while (x > 0 && y > 0) {
      if (expected[x - 1] === got[y - 1]) {
        tokens.push({ w: expected[x - 1], ok: true });
        x--; y--;
      } else if (dp[x - 1][y] >= dp[x][y - 1]) {
        tokens.push({ w: expected[x - 1], miss: true });
        x--;
      } else {
        tokens.push({ w: got[y - 1], extra: true });
        y--;
      }
    }
    while (x > 0) tokens.push({ w: expected[--x], miss: true });
    while (y > 0) tokens.push({ w: got[--y], extra: true });
    return tokens.reverse();
  }

  /**
   * 判一句。
   *
   * @param {string} answer 标准答案（原句）
   * @param {string} input  用户写下的
   * @returns {{tokens:Array, correct:number, total:number,
   *            miss:number, extra:number, rate:number, perfect:boolean, empty:boolean}}
   */
  function check(answer, input) {
    var exp = normalizeWords(answer);
    var got = normalizeWords(input);
    var tokens = align(exp, got);
    var correct = 0, miss = 0, extra = 0;
    tokens.forEach(function (t) {
      if (t.ok) correct++;
      else if (t.miss) miss++;
      else extra++;
    });
    return {
      tokens: tokens,
      correct: correct,
      total: exp.length,
      miss: miss,
      extra: extra,
      rate: exp.length ? correct / exp.length : 0,
      // 全对：一个不漏、一个不多（多写的也算听错了）
      perfect: exp.length > 0 && correct === exp.length && extra === 0,
      empty: got.length === 0
    };
  }

  /** 整段汇总：按词数加权，不是按句平均 —— 长句本就该占更大分量 */
  function summary(results) {
    var ok = 0, total = 0, perfect = 0, n = (results || []).length;
    (results || []).forEach(function (r) {
      if (!r) return;
      ok += r.correct;
      total += r.total;
      if (r.perfect) perfect++;
    });
    return {
      sentences: n,
      perfect: perfect,
      correct: ok,
      total: total,
      rate: total ? ok / total : 0
    };
  }

  return {
    normalizeWords: normalizeWords,
    align: align,
    check: check,
    summary: summary
  };
});
