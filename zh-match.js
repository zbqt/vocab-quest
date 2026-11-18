/* 中文释义判分：判断「用户手写的汉语意思」和词库里的释义是不是一回事。
 *
 * 为什么不能直接字符串相等：词库释义是词典格式，一条里塞了好几层东西 ——
 *   `adj. 能；[经管] 有能力的；能干的；n. (Able)人名；(伊朗)阿布勒；(英)埃布尔`
 * 用户听对了只会写「能干」或「有能力的」，直接比必然全错。
 * 这一步要做的是：把标准答案拆成一组可以互换的说法，用户写出其中任何一个都算对。
 *
 * 三条宽松规则（都有长度门槛，避免「的」「不」这种单字乱匹配）：
 *   1. 拆开的义项完全相同 → 对
 *   2. 标准义项包含用户写的内容（用户写的是它的子串）→ 对
 *   3. 用户写的内容包含标准义项 → 对（用户把两三个义项连起来写了）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VQZh = api;
})(this, function () {
  "use strict";

  // 词性标记：出现在义项开头，对判分毫无信息量，先剥掉
  var POS = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr|pl|a)\s*\.\s*/i;
  // 学科 / 语域标记：[经管] [医] [化] [口] 这类方括号内容
  var DOMAIN = /\[[^\]]{0,8}\]/g;
  // 人名段：`(Able)人名；(伊朗)阿布勒`，对背单词零价值，整段丢掉
  var PERSON = /人名/;

  /* 归一化：全角转半角（只处理会出现在译文里的全角），去掉所有空白和标点。
   * 标点去掉是必须的 —— 用户写「牺牲、牺牲品」，标准写「牺牲；牺牲品」，
   * 分隔符不一样不代表意思不一样。 */
  function normalize(s) {
    var str = String(s == null ? "" : s);
    // 全角字母数字 → 半角
    str = str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
    // 中文/英文标点、空白一律抹掉
    str = str.replace(/[\s\u3000]/g, "");
    str = str.replace(/[，,；;、。.．·！!？?“”"'‘’（）()《》〈〉【】\[\]{}<>:：\/\\|~`@#$%^&*_+=—-]+/g, "");
    return str;
  }

  /* 把一条词典释义拆成「可以互换的说法」。
   * 先按分号切（一个义项内部还可能用逗号并列表述），
   * 再剥词性、剥学科标记，丢掉人名段，最后归一化去重。 */
  function senses(zh) {
    var raw = String(zh == null ? "" : zh);
    var parts = raw.split(/[；;]/);
    var out = [];
    var seen = {};
    var inPerson = false;

    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      // 人名段整段丢掉。它从来不是一段 —— `n. (And)人名；(土、瑞典)安德` 是两段，
      // 只看"人名"两个字会把后面的音译「安德」留下来，等于让用户能靠一个地名答对。
      if (PERSON.test(seg)) { inPerson = true; continue; }
      if (inPerson) {
        // 人名后面的音译段都以括号开头；碰到不带括号的，说明人名已经结束
        if (/^\s*[（(]/.test(seg)) continue;
        inPerson = false;
      }

      seg = seg.replace(DOMAIN, " ");
      seg = seg.replace(POS, "");
      // 去掉括号里的修饰：「(英)埃布尔」「(口语)」这类
      seg = seg.replace(/[（(][^）)]{0,10}[）)]/g, " ");

      // 一个义项内部常用逗号并列近义说法：「和，与」「就，而且」
      var subs = seg.split(/[，,]/);
      for (var k = 0; k < subs.length; k++) {
        var one = normalize(subs[k]);
        if (!one || one.length < 1) continue;
        if (seen[one]) continue;
        seen[one] = 1;
        out.push(one);
      }
    }
    return out;
  }

  // 用户可能一次写好几个义项：按分隔符拆开逐个比
  function inputs(s) {
    var raw = String(s == null ? "" : s);
    var parts = raw.split(/[；;，,、\/]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var one = normalize(parts[i]);
      if (one) out.push(one);
    }
    // 整体也当一个候选：用户可能不带分隔符连着写
    var whole = normalize(raw);
    if (whole && out.indexOf(whole) < 0) out.push(whole);
    return out;
  }

  function hit(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // 子串也算：写「能干」对「有能力的」应该算对；长度门槛挡住「的」「不」这种单字
    if (a.length >= 2 && b.indexOf(a) >= 0) return true;
    if (b.length >= 2 && a.indexOf(b) >= 0) return true;
    return false;
  }

  /**
   * 判分。
   * @returns {{ok:boolean, matched:string, senses:string[]}}
   *   matched = 命中的那个标准义项（用来在反馈里说「对，'能干'也是这个意思」）
   */
  function check(zh, input) {
    var std = senses(zh);
    var got = inputs(input);
    var best = "";
    for (var i = 0; i < got.length; i++) {
      for (var k = 0; k < std.length; k++) {
        // 完全一致优先：用户写「牺牲」就该回「牺牲」，不能回「牺牲品」——
        // 反馈里那个词是要让用户确认「我写的确实是这个意思」。
        if (got[i] === std[k]) return { ok: true, matched: std[k], senses: std };
        if (hit(got[i], std[k]) && std[k].length > best.length) best = std[k];
      }
    }
    return { ok: !!best, matched: best, senses: std };
  }

  /* 能接受的说法太多时，反馈里只列前几个 —— 全列出来是一堵墙，不是提示 */
  function hint(zh, max) {
    var list = senses(zh);
    var n = max || 3;
    return list.slice(0, n);
  }

  return {
    normalize: normalize,
    senses: senses,
    check: check,
    hint: hint
  };
});
