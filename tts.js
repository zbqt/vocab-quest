/* VQSpeech —— 浏览器原生 TTS 的移动端加固封装
 *
 * 手机端不出声通常不是"没实现"，而是这几处：
 *   1. speechSynthesis.cancel() 是异步的，紧接着 speak() 新语音会被吞（iOS/Android 都中）
 *   2. 只设 lang="en-US" 不指定 voice，系统里没有对应引擎时静默失败，连 onerror 都不给
 *   3. iOS 要求首次 speak 发生在用户手势的同步调用栈里，晚一拍就 not-allowed
 *   4. 页面切后台回来 synth.paused=true，之后怎么 speak 都不响
 *   5. 有些引擎不触发 onstart，另一些不触发 onend —— 不能靠单一事件判断成败
 *
 * 这一份把上述情况都兜住，对外只暴露 speak / diagnose。
 */
(function (global) {
  "use strict";

  // 不缓存引用：页面加载时可能还没有 speechSynthesis，或之后被替换
  function getSynth() {
    try { return global.speechSynthesis || null; } catch (e) { return null; }
  }
  function hasCtor() {
    try { return typeof global.SpeechSynthesisUtterance === "function"; } catch (e) { return false; }
  }
  function supported() { return !!(getSynth() && hasCtor()); }

  var REASON_TEXT = {
    unsupported: "这个浏览器不支持朗读，换 Chrome 或 Safari 试试",
    "not-allowed": "浏览器要求先点一下页面才能发声，点任意位置再试",
    "synthesis-failed": "语音合成失败，系统的语音引擎可能异常",
    "language-unavailable": "系统里没有英文语音包，到设置里下载一个",
    "voice-unavailable": "系统里没有英文语音包，到设置里下载一个",
    "text-too-long": "这个词太长，语音引擎处理不了",
    "audio-busy": "音频被其它应用占用，等一下再试",
    "audio-hardware": "没有可用的音频输出设备",
    network: "这个语音引擎要联网，检查一下网络",
    interrupted: "朗读被打断了，再点一次",
    "not-started": "没发出声音：可能是手机侧边静音开关，或系统没装英文语音",
    empty: "这个词没有可朗读的内容"
  };

  /* ---------- 选英文音色 ---------- */
  var voiceCache = null;
  var voicesBound = false;

  function scoreVoice(v) {
    var lang = String(v.lang || "").replace("_", "-").toLowerCase();
    if (lang.indexOf("en") !== 0) return -1;
    var s = lang === "en-us" ? 30 : 10;
    if (v.localService) s += 5; // 本地引擎：离线可用、响应快
    if (/samantha|google us english|microsoft (aria|zira|jenny|guy|michelle)|aaron|nicky/i.test(v.name || "")) s += 3;
    return s;
  }

  function pickVoice() {
    var s = getSynth();
    if (!s || typeof s.getVoices !== "function") return null;
    if (voiceCache !== null) return voiceCache;
    var list = [];
    try { list = s.getVoices() || []; } catch (e) { list = []; }
    if (!list.length) return null; // voices 异步加载：空结果不缓存，等 voiceschanged
    var best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var sc = scoreVoice(list[i]);
      if (sc > bestScore) { bestScore = sc; best = list[i]; }
    }
    voiceCache = bestScore >= 10 ? best : null;
    return voiceCache;
  }

  function bindVoices() {
    if (voicesBound) return;
    var s = getSynth();
    if (!s) return;
    voicesBound = true;
    try {
      if (typeof s.addEventListener === "function") {
        s.addEventListener("voiceschanged", function () {
          voiceCache = null;
          pickVoice();
        });
      }
      pickVoice(); // 主动触发一次加载（Chrome 需要）
    } catch (e) {}
  }

  /* ---------- 小工具 ---------- */
  function once(fn) {
    var called = false;
    return function () {
      if (called) return;
      called = true;
      fn.apply(null, arguments);
    };
  }

  function resumeIfPaused(s) {
    try { if (s.paused) s.resume(); } catch (e) {}
  }

  function buildUtterance(text, voice) {
    var u = new global.SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || "en-US";
    u.rate = 0.85;
    u.pitch = 1;
    u.volume = 1;
    return u;
  }

  /* ---------- 主入口 ---------- */
  /**
   * @param {string} text
   * @param {{onStart?:Function, onDone?:Function(done:boolean, reason?:string)}} hooks
   * @returns {boolean} 是否已尝试发声
   */
  function speak(text, hooks) {
    hooks = hooks || {};
    var finish = once(function (ok, reason) {
      if (hooks.onDone) hooks.onDone(ok, reason || (ok ? "" : "not-started"));
    });

    if (!supported()) { finish(false, "unsupported"); return false; }
    if (!text || !String(text).trim()) { finish(false, "empty"); return false; }

    bindVoices();
    var s = getSynth();
    var voice = pickVoice();
    resumeIfPaused(s);

    var busy = false;
    try { busy = !!(s.speaking || s.pending); } catch (e) {}

    if (!busy) {
      // 空闲：同步调用，保住用户手势上下文（iOS 必须）
      start();
    } else {
      // 正在读：cancel 是异步的，必须让出一轮事件循环，否则新语音会被吞
      try { s.cancel(); } catch (e) {}
      setTimeout(start, 0);
    }
    return true;

    function start() {
      var live = getSynth();
      if (!live) { finish(false, "unsupported"); return; }

      var u;
      try { u = buildUtterance(text, voice); }
      catch (e) { finish(false, "synthesis-failed"); return; }

      var started = false, settled = false;
      var watchdog = null, grace = null, giveUp = null;

      function clearTimers() {
        clearTimeout(watchdog); clearTimeout(grace); clearTimeout(giveUp);
      }
      function markStarted() {
        if (started) return;
        started = true;
        if (hooks.onStart) hooks.onStart();
      }
      function settle(ok, reason) {
        if (settled) return;
        settled = true;
        clearTimers();
        finish(ok, reason);
      }

      u.onstart = markStarted;
      u.onend = function () { settle(true); };
      u.onerror = function (ev) { settle(false, (ev && ev.error) || "synthesis-failed"); };

      try { live.speak(u); } catch (e) { settle(false, "synthesis-failed"); return; }
      if (settled) return; // 引擎同步就结束了（或桩函数），不必再挂 watchdog

      // 600ms 内没收到 onstart：判断是真被吞，还是引擎只是不派发 onstart
      watchdog = setTimeout(function () {
        if (settled) return;
        var cur = getSynth();
        var speakingNow = false;
        try { speakingNow = !!(cur && cur.speaking); } catch (e) {}
        if (speakingNow) { markStarted(); return; } // 已经在读，只是没派事件

        try { if (cur) cur.cancel(); } catch (e) {}
        setTimeout(function () {
          if (settled) return;
          var s2 = getSynth();
          if (!s2) { settle(false, "unsupported"); return; }
          var u2;
          try { u2 = buildUtterance(text, voice); }
          catch (e) { settle(false, "synthesis-failed"); return; }
          u2.onstart = markStarted;
          u2.onend = function () { settle(true); };
          u2.onerror = function (ev) { settle(false, (ev && ev.error) || "synthesis-failed"); };
          try { s2.speak(u2); } catch (e) { settle(false, "synthesis-failed"); return; }

          giveUp = setTimeout(function () {
            if (settled) return;
            var alive = false;
            try { alive = !!(getSynth() && getSynth().speaking); } catch (e) {}
            if (alive) { markStarted(); return; }
            settle(false, "not-started");
          }, 1500);
        }, 80);
      }, 600);

      // 已开始但引擎不派发 onend（旧版 Safari 有过）：8 秒收尾，按成功算
      grace = setTimeout(function () {
        if (settled) return;
        if (started) settle(true);
      }, 8000);
    }
  }

  /* ---------- 诊断（"为什么没声音"找原因） ---------- */
  function diagnose() {
    var s = getSynth();
    var list = [];
    try { if (s && typeof s.getVoices === "function") list = s.getVoices() || []; } catch (e) {}
    var picked = null;
    try { picked = pickVoice(); } catch (e) {}
    var english = [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].lang || "").toLowerCase().indexOf("en") === 0) english.push(list[i]);
    }
    return {
      supported: supported(),
      totalVoices: list.length,
      englishVoices: english.map(function (v) { return v.name + " (" + v.lang + ")"; }),
      pickedVoice: picked ? picked.name + " (" + picked.lang + ")" : null,
      paused: !!(s && s.paused),
      speaking: !!(s && s.speaking),
      wechat: /MicroMessenger/i.test(global.navigator ? global.navigator.userAgent : "")
    };
  }

  function reasonText(code) { return REASON_TEXT[code] || "发声失败，再点一次试试"; }

  // iOS/安卓切后台会把引擎挂起，回到前台不 resume 就一直不出声
  try {
    if (global.document && typeof global.document.addEventListener === "function") {
      global.document.addEventListener("visibilitychange", function () {
        if (!global.document.hidden) {
          voiceCache = null;
          resumeIfPaused(getSynth());
          pickVoice();
        }
      });
    }
  } catch (e) {}

  global.VQSpeech = {
    speak: speak,
    diagnose: diagnose,
    reasonText: reasonText,
    pickVoice: pickVoice,
    get supported() { return supported(); },
    get isWeChat() { return /MicroMessenger/i.test(global.navigator ? global.navigator.userAgent : ""); }
  };
})(typeof window !== "undefined" ? window : this);
