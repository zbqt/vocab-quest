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

  /* ---------- 在线发音兜底 ----------
   * 国产安卓浏览器（vivo / 小米 / QQ / 夸克 等）大多没有 speechSynthesis，
   * 国产安卓机也普遍没装英文语音包。光靠原生 TTS，这些机器就是死的。
   * 所以备一条 mp3 通道：拿不到原生能力时自动改用在线音频，用户无感。
   * 缺点是要联网；好处是「能不能响」不再取决于浏览器和系统语音包。 */
  var AUDIO_SOURCES = [
    function (w) { return "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(w) + "&type=2"; }, // 美音
    function (w) { return "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(w) + "&type=1"; }  // 英音
  ];
  var currentAudio = null;

  function stopAudio() {
    if (!currentAudio) return;
    try {
      currentAudio.pause();
      currentAudio.removeAttribute("src");
      currentAudio.load();
    } catch (e) {}
    currentAudio = null;
  }

  var REASON_TEXT = {
    unsupported: "这个浏览器既不能朗读，在线发音也没加载成功，检查一下网络",
    "audio-unavailable": "在线发音没加载成功，检查一下网络，或换 Chrome / Safari",
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

  /* 语速：两条通道共用一个值，改这里就行。
   * 0.75 比正常慢一档。背单词听得清比听得快重要，用户反馈「太快」后从 0.85 降下来。
   * 注意：原生通道用 utterance.rate，mp3 通道用 audio.playbackRate，语义一致但实现不同，
   * 忘记同步就会变成「换了个浏览器，语速突然变快」。 */
  var SPEED = 0.75;

  function buildUtterance(text, voice) {
    var u = new global.SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || "en-US";
    u.rate = SPEED;
    u.pitch = 1;
    u.volume = 1;
    return u;
  }

  /* 走 mp3 通道。多个源依次重试，任何一个成功就算成功。 */
  function speakViaAudio(text, hooks, finish) {
    var word = String(text).trim();
    if (!word) { finish(false, "empty"); return false; }
    if (typeof global.Audio !== "function") { finish(false, "unsupported"); return false; }

    stopAudio();
    var idx = 0;
    playNext();
    return true;

    function playNext() {
      if (idx >= AUDIO_SOURCES.length) { finish(false, "audio-unavailable"); return; }
      var a;
      try { a = new global.Audio(AUDIO_SOURCES[idx++](word)); }
      catch (e) { finish(false, "audio-unavailable"); return; }

      currentAudio = a;
      a.preload = "auto";
      // 放慢但尽量不变调（各浏览器前缀不同，都设一遍）
      try {
        a.preservesPitch = true;
        a.mozPreservesPitch = true;
        a.webkitPreservesPitch = true;
      } catch (e) {}
      try { a.defaultPlaybackRate = SPEED; a.playbackRate = SPEED; } catch (e) {}
      var retried = false;
      var stall = null;

      function clearStall() { if (stall) { clearTimeout(stall); stall = null; } }

      a.onplaying = function () { clearStall(); if (hooks.onStart) hooks.onStart(); };
      a.onended = function () { clearStall(); if (currentAudio === a) currentAudio = null; finish(true); };
      a.onerror = function () {
        clearStall();
        if (retried) return;
        retried = true;
        playNext(); // 换下一个源（比如这个没收录该词）
      };

      // 卡住不发事件时（弱网/被拦），别让按钮永远停在"播放中"
      stall = setTimeout(function () {
        if (currentAudio !== a || retried) return;
        var rs = 0;
        try { rs = a.readyState || 0; } catch (e) {}
        if (rs >= 2) return; // 已经在下载/可播了，只是慢
        retried = true;
        playNext();
      }, 4000);
      if (stall && typeof stall.unref === "function") stall.unref();

      var p;
      try { p = a.play(); } catch (e) { clearStall(); playNext(); return; }
      if (p && typeof p.then === "function") {
        p.catch(function (err) {
          clearStall();
          // 手势不足时换源也没用，直接说清楚，别让用户干等
          if (err && err.name === "NotAllowedError") { finish(false, "not-allowed"); return; }
          if (retried) return;
          retried = true;
          playNext();
        });
      }
    }
  }

  // 原生通道失败、且一个字都没读出来时，才轮到音频通道（已出声就绝不重来，避免播两遍）
  function canFallback(reason) {
    return reason === "unsupported" || reason === "synthesis-failed" ||
      reason === "language-unavailable" || reason === "voice-unavailable" ||
      reason === "not-started";
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

    if (!text || !String(text).trim()) { finish(false, "empty"); return false; }
    // 浏览器压根没有朗读能力（国产安卓浏览器常见）：直接走音频通道
    if (!supported()) return speakViaAudio(text, hooks, finish);

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
      if (!live) { speakViaAudio(text, hooks, finish); return; }

      var u;
      try { u = buildUtterance(text, voice); }
      catch (e) { speakViaAudio(text, hooks, finish); return; }

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
        // 一个字都没读出来 + 属于可兜底的原因 → 改用在线音频，用户不必知道
        if (!ok && !started && canFallback(reason)) {
          speakViaAudio(text, hooks, finish);
          return;
        }
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
      mode: supported() ? "native" : "audio",
      ua: String((global.navigator && global.navigator.userAgent) || ""),
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
    stop: stopAudio,
    diagnose: diagnose,
    reasonText: reasonText,
    pickVoice: pickVoice,
    get supported() { return supported(); },
    get mode() { return supported() ? "native" : "audio"; },
    get isWeChat() { return /MicroMessenger/i.test(global.navigator ? global.navigator.userAgent : ""); }
  };
})(typeof window !== "undefined" ? window : this);
