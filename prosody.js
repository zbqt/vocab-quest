/*!
 * VQProsody —— 把一句台词排成「像人在说」的片段序列
 *
 * 系统语音合成之所以听着机械，不是因为音色，而是因为它把整句当成一条直线：
 * 语速恒定、音高恒定、逗号处几乎没有停顿、换人说话也没有任何区别。
 * 真人说话恰好相反 —— 有气口、有轻重、问句尾巴会翘、说到坏消息会变快变低。
 *
 * 这一份只做「怎么排」，不做「怎么发声」，所以是纯函数，可以单测。
 * 真正的播放交给 tts.js 的 speakDialogue，它按 segments 逐段念、按 pause 留白。
 */
(function (global) {
  "use strict";

  /* ---------- 音标比较键 ----------
   * 同音词（see / sea）在词库里音标写法可能差一个重音符号或长音符号，
   * 直接字符串比对会漏。去掉重音、长音、斜杠、空格后再比，才算得上「听起来一样」。 */
  function soundKey(ph) {
    return String(ph == null ? "" : ph)
      .toLowerCase()
      .replace(/[\/\[\]()]/g, "")
      .replace(/[ˈˌ'’\-.\s]/g, "")
      .replace(/ː/g, "")
      .replace(/ɜr/g, "ər")
      .replace(/əʊ/g, "oʊ");
  }

  /* ---------- 气口 ----------
   * 真人逗号停 150~200ms、分号略长、句号停 300ms 左右。
   * 停太长像机器在等指令，停太短又黏成一片，这组数是按正常交谈的节奏定的。 */
  var PAUSE = { comma: 170, semi: 240, colon: 220, dash: 200, end: 300 };
  var BREAK = { ",": "comma", ";": "semi", ":": "colon", "—": "dash", ".": "end", "?": "end", "!": "end" };

  /* 把句子切成「一口气」：在逗号/分号/冒号/破折号/句末断开，标点留在片段里，
   * 因为标点本身就是给引擎的语调提示，删掉反而更平。 */
  function splitClauses(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return [];
    var out = [], buf = "", pause = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      buf += ch;
      var key = BREAK[ch];
      if (!key) continue;
      // 小数点、缩写点不切（5.30 / Mr. / e.g.）；切了会念成两个句子
      if (ch === "." && /\d$/.test(s.slice(0, i)) && /^\d/.test(s.slice(i + 1))) continue;
      if (ch === "." && /\b(mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|prof)$/i.test(s.slice(0, i))) continue;
      var piece = buf.trim();
      buf = "";
      if (!piece) continue;
      out.push({ text: piece, pause: PAUSE[key] });
      pause = PAUSE[key];
    }
    if (buf.trim()) out.push({ text: buf.trim(), pause: 0 });
    if (out.length) out[out.length - 1].pause = 0; // 最后一段不留白，收尾由调用方决定

    // 一两个词的碎片（"Yes," / "Okay,"）单独成句会听起来一顿一顿的，
    // 并到后一段里，让引擎自己在逗号处处理那个微停。
    var merged = [];
    for (var k = 0; k < out.length; k++) {
      var cur = out[k];
      var words = cur.text.split(/\s+/).filter(Boolean).length;
      if (words <= 1 && k + 1 < out.length) {
        out[k + 1].text = cur.text + " " + out[k + 1].text;
        continue;
      }
      merged.push(cur);
    }
    return merged;
  }

  /* ---------- 说话人声线 ----------
   * A 稍亮稍快（前台、接待、老师），B 稍低沉稍慢（顾客、学生、求助者）。
   * 只靠音高区分也能听出「换人了」，但如果系统里有两个英文音色，tts.js 会优先用两个真音色。 */
  var SPEAKERS = {
    A: { rate: 1.0, pitch: 1.04 },
    B: { rate: 0.97, pitch: 0.9 }
  };

  /* ---------- 情绪 ----------
   * 不做语义分析，只看几个高频信号词，给音高和语速一点点偏移。
   * 偏移都很小（±0.03 量级）—— 大了就成了朗诵腔，比机械更假。 */
  var EMO = [
    { re: /\b(sorry|excuse me|afraid|apolog)/i, warm: 1 },
    { re: /\b(please|thank you|thanks)\b/i, warm: 1 },
    { re: /\b(great|perfect|wonderful|sounds good|love|glad|happy|nice)\b/i, warm: 2 },
    { re: /\b(problem|late|broken|wrong|expensive|worried|busy|closed|delay|cancel|missed)\b/i, tense: 1 },
    { re: /\b(can't|cannot|don't|won't|didn't|never)\b/i, tense: 1 }
  ];

  function readEmotion(text) {
    var warm = 0, tense = 0;
    for (var i = 0; i < EMO.length; i++) {
      if (EMO[i].re.test(text)) { warm += EMO[i].warm || 0; tense += EMO[i].tense || 0; }
    }
    return { warm: Math.min(2, warm), tense: Math.min(2, tense) };
  }

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 排一句台词。
   * @param {string} text
   * @param {{speaker?:string, speed?:number}} opts speed 是全局倍速（1 正常 / 0.8 慢速）
   * @returns {{speaker:string, segments:Array, emotion:object}}
   */
  function planLine(text, opts) {
    opts = opts || {};
    var speaker = opts.speaker === "B" ? "B" : "A";
    var base = SPEAKERS[speaker];
    var speed = typeof opts.speed === "number" && opts.speed > 0 ? opts.speed : 1;
    var raw = splitClauses(text);
    var emo = readEmotion(text);
    var segments = [];

    for (var i = 0; i < raw.length; i++) {
      var seg = raw[i];
      var last = i === raw.length - 1;
      var tail = /[?]\s*$/.test(seg.text) ? 1 : (/[!]\s*$/.test(seg.text) ? 0.5 : 0);

      // 每段 ±3% 的语速抖动：真人不会每个字都一样快，恒定速度是最明显的机械感来源。
      var jitter = ((hash(seg.text + i) % 7) - 3) / 100;
      var rate = base.rate + jitter - emo.warm * 0.015 + emo.tense * 0.02;
      var pitch = base.pitch;

      if (!last) pitch += 0.015;              // 话没说完，尾音略抬，像在等对方
      if (last) {
        pitch += tail * 0.06;                 // 问句翘尾，感叹句也抬一点
        pitch -= (1 - tail) * 0.02;           // 陈述句收尾略沉
      }
      pitch += emo.warm * 0.015 - emo.tense * 0.01;

      segments.push({
        text: seg.text,
        rate: clamp(rate * speed, 0.6, 1.6),
        pitch: clamp(pitch, 0.7, 1.3),
        pause: seg.pause,
        final: last
      });
    }
    if (!segments.length) segments.push({ text: "", rate: base.rate * speed, pitch: base.pitch, pause: 0, final: true });

    return { speaker: speaker, segments: segments, emotion: emo };
  }

  /* ---------- 选音色 ----------
   * 同一句英文，不同引擎出来的自然度差得非常远。排序原则：
   * 云端神经网络音色 > 浏览器大厂音色 > 本地音色 > 低质压缩音色。
   * 「Natural / Online / Neural」这几个词只出现在真正好的音色名字里，
   * 比如 Edge 的 "Microsoft Aria Online (Natural)"，比默认本地引擎自然一个档。 */
  function scoreVoice(v) {
    if (!v) return -1;
    var name = String(v.name || "");
    var lang = String(v.lang || "").replace("_", "-").toLowerCase();
    if (lang.indexOf("en") !== 0) return -1;
    var s = 20;
    if (/natural|neural|online/i.test(name)) s += 60;
    if (/google/i.test(name)) s += 40;
    if (/aria|jenny|guy|michelle|ava|allison|susan|samantha|karen|daniel|moira|tessa|serena|tom|emma|brian|amy/i.test(name)) s += 12;
    if (lang === "en-us") s += 8;
    else if (lang === "en-gb") s += 6;
    if (v.localService) s += 4;                 // 本地音色不卡、离线也能用
    if (/compact|espeak|pico|festival/i.test(name)) s -= 30; // 老式低质引擎，能避就避
    return s;
  }

  function voiceOptions(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var sc = scoreVoice(list[i]);
      if (sc < 0) continue;
      out.push({
        name: list[i].name,
        lang: list[i].lang,
        score: sc,
        natural: /natural|neural|online/i.test(list[i].name || ""),
        local: !!list[i].localService
      });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /* 挑两个音色给 A / B。用户手动选过就尊重用户；没有第二个英文音色就复用同一个，
   * 靠 planLine 里的音高差把两个人分开。 */
  function pickVoices(list, chosenName) {
    var opts = voiceOptions(list);
    var a = null, b = null;
    if (chosenName) {
      for (var i = 0; i < opts.length; i++) if (opts[i].name === chosenName) a = opts[i];
    }
    if (!a) a = opts[0] || null;
    for (var k = 0; k < opts.length; k++) {
      if (opts[k].name !== (a && a.name)) { b = opts[k]; break; }
    }
    return { a: a, b: b || a, distinct: !!(a && b && a.name !== b.name), options: opts };
  }

  var API = {
    soundKey: soundKey,
    splitClauses: splitClauses,
    planLine: planLine,
    scoreVoice: scoreVoice,
    voiceOptions: voiceOptions,
    pickVoices: pickVoices,
    PAUSE: PAUSE
  };
  global.VQProsody = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : this);
