/*!
 * VQSentence —— 整句人声音频（云端 TTS）
 *
 * 单词有词典的真人录音，整句却一直只能走设备自带的语音引擎 —— 那套引擎是十几年前的
 * 拼接式合成，声音又平又硬，这就是"人机感"的真正来源。换断句、换停顿、换音高只能
 * 修饰表面，底子换不掉。
 *
 * 这一份只做"怎么要这一段声音"：把台词变成一条可以直接喂给 <audio> 的地址。
 * 不做播放（播放交给 tts.js 的 speakCloud），所以是纯函数，可以单测。
 *
 * 两个硬事实，写在这里免得以后有人再踩：
 *
 * 1. **必须没有 Referer**。这个接口对带 Referer 的请求返回 200 + 0 字节，
 *    <audio> 收到就报 MEDIA_ERR_SRC_NOT_SUPPORTED（code 4），看起来像"格式不支持"，
 *    其实是防盗链。referrerpolicy 不是 <audio> 的合法属性，元素级设了也没用，
 *    只能靠文档级的 <meta name="referrer" content="no-referrer">。所以这个模块
 *    只有放进了设了那条 meta 的页面才有效。
 *
 * 2. **整句一次要，不要按气口拆**。拆开要会把每段都念成"一个句子的结尾"——
 *    每段尾巴都降调，连起来像一串短句，比整句更机械。停顿时长交给引擎自己按标点处理，
 *    它做的事比我们硬切更自然。只有超长（>280 字符）才按句子边界拆，那时候拆比不拆好。
 *
 * 音色只有一个人（en）。第二个人（uk）用的是英式口音的那一路，是另一条合成声线，
 * 音色明显不同 —— 对话里分得清"谁在说"比口音统一更重要。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VQSentence = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ENDPOINT = "https://fanyi.baidu.com/gettts";
  var MAX_CHARS = 280;

  // 两个人两条声线。en = 美音，uk = 英音（实测时长与音色都不同，是另一条合成声线）
  var ACCENT = { A: "en", B: "uk" };

  function accentOf(speaker) {
    return ACCENT[speaker === "B" ? "B" : "A"];
  }

  /* 清洗：只做"不改意思、但能避免引擎念错"的替换。
   * — 和 – 有些引擎会念成 "dash"，换成逗号（气口还在，词不会被念出来）。 */
  function clean(text) {
    return String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .replace(/[—–]{1,2}/g, ", ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/,\s*,+/g, ",")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* 超长句按句末切，再把小句合并到不超过 max。
   * 真的遇到一个标点都没有的长句，才在空格处硬切。 */
  function splitLong(s, max) {
    max = max || MAX_CHARS;
    if (s.length <= max) return [s];

    var pieces = s.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [s];
    var merged = [], buf = "";
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i].trim();
      if (!p) continue;
      if (buf && (buf + " " + p).length > max) { merged.push(buf); buf = p; }
      else buf = buf ? buf + " " + p : p;
    }
    if (buf) merged.push(buf);

    var out = [];
    for (var k = 0; k < merged.length; k++) {
      var chunk = merged[k];
      while (chunk.length > max) {
        var cut = chunk.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        out.push(chunk.slice(0, cut).trim());
        chunk = chunk.slice(cut).trim();
      }
      if (chunk) out.push(chunk);
    }
    return out;
  }

  function url(text, opts) {
    opts = opts || {};
    var accent = opts.accent === "uk" ? "uk" : "en";
    return ENDPOINT +
      "?lan=" + accent +
      "&text=" + encodeURIComponent(String(text == null ? "" : text).trim()) +
      "&spd=" + (opts.spd || 3) +
      "&source=web";
  }

  /**
   * 把一句台词排成可以顺序播放的音频片段。
   * @returns {Array<{text:string,url:string,gap:number}>} gap = 这段播完后额外留白（毫秒）
   */
  function cues(text, opts) {
    opts = opts || {};
    var s = clean(text);
    if (!s) return [];
    var accent = accentOf(opts.speaker);
    var parts = splitLong(s, opts.maxChars || MAX_CHARS);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      out.push({
        text: parts[i],
        url: url(parts[i], { accent: accent }),
        // 拆出来的地方原本是句号，音频自己会收尾，这里只补一点点气口
        gap: i < parts.length - 1 ? 140 : 0
      });
    }
    return out;
  }

  return {
    ENDPOINT: ENDPOINT,
    MAX_CHARS: MAX_CHARS,
    ACCENT: ACCENT,
    accentOf: accentOf,
    clean: clean,
    splitLong: splitLong,
    url: url,
    cues: cues
  };
});
