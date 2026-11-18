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

  /* ---------- 录音通道 ----------
   * 国产安卓浏览器（vivo / 小米 / QQ / 夸克 等）大多没有 speechSynthesis，
   * 国产安卓机也普遍没装英文语音包；就算有，手机自带的英文合成音也普遍机械。
   * 所以默认走有道词典的真人录音（单词级别是真人发音，不是合成），
   * 失败或断网时才退回系统合成。音源顺序见 audioSources()。 */
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

  /* 语速只作用于「系统合成」。
   * 真人录音**绝不时间拉伸** —— 短单词做 0.75x 变速（哪怕保音调）会拉出明显的金属味、
   * 水声，比原速难听得多。有道那条录音本身是 48kHz/66kbps、1.4 秒的慢速清晰发音，
   * 已经是"背单词该有的速度"，再拉就是负优化。 */
  var SPEED = 0.8;

  /* 发音风格：us = 美音录音，uk = 英音录音，native = 系统合成（离线可用但普遍机械）。
   * 默认 us —— 国产手机自带的英文合成音大多很机械，真人录音优先。 */
  var PREF_KEY = "vq_voice_pref";
  var VOICES = [
    { id: "us", name: "美音", src: "type=2", native: false },
    { id: "uk", name: "英音", src: "type=1", native: false },
    { id: "native", name: "系统合成", src: "", native: true }
  ];

  function pref() {
    var v = null;
    try { v = global.localStorage && global.localStorage.getItem(PREF_KEY); } catch (e) {}
    for (var i = 0; i < VOICES.length; i++) if (VOICES[i].id === v) return v;
    return "us";
  }
  function setPref(id) {
    for (var i = 0; i < VOICES.length; i++) {
      if (VOICES[i].id === id) {
        try { global.localStorage.setItem(PREF_KEY, id); } catch (e) {}
        return id;
      }
    }
    return pref();
  }
  function prefName() {
    var p = pref();
    for (var i = 0; i < VOICES.length; i++) if (VOICES[i].id === p) return VOICES[i].name;
    return "美音";
  }
  // 按偏好排出录音源顺序：选了英音就把英音放前面，另一种音作备用
  function audioSources() {
    var p = pref();
    var order = p === "uk" ? ["uk", "us"] : ["us", "uk"];
    return order.map(function (id) {
      var v = VOICES.filter(function (x) { return x.id === id; })[0];
      return function (w) {
        return "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(w) + "&" + v.src;
      };
    });
  }

  function buildUtterance(text, voice) {
    var u = new global.SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || "en-US";
    u.rate = SPEED;
    u.pitch = 1;
    u.volume = 1;
    return u;
  }

  /* 走录音通道。多个音源依次重试，任何一个成功就算成功。
   * onFail：两条路都不通时交给上层（可能还有系统合成可用）。 */
  function speakViaAudio(text, hooks, finish, onFail) {
    var sources = audioSources();
    var word = String(text).trim();
    if (!word) { finish(false, "empty"); return false; }
    if (typeof global.Audio !== "function") { fail("unsupported"); return false; }

    stopAudio();
    var idx = 0;
    playNext();
    return true;

    function fail(reason) { if (onFail) onFail(reason); else finish(false, reason); }

    function playNext() {
      if (idx >= sources.length) { fail("audio-unavailable"); return; }
      var a;
      try { a = new global.Audio(sources[idx++](word)); }
      catch (e) { fail("audio-unavailable"); return; }

      currentAudio = a;
      a.preload = "auto";
      // 录音按原速播，不做任何时间拉伸（拉伸会把短词拉出金属味）
      try { a.defaultPlaybackRate = 1; a.playbackRate = 1; } catch (e) {}
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

    // 两条通道按用户选的风格排先后：选「系统合成」就先合成，否则先放真人录音
    var order = pref() === "native" ? ["native", "audio"] : ["audio", "native"];
    var stage = 0;
    next("");

    function next(reason) {
      while (stage < order.length) {
        var ch = order[stage++];
        if (ch === "native" && supported()) { nativeSpeak(text, hooks, finish, next); return; }
        if (ch === "audio") { speakViaAudio(text, hooks, finish, next); return; }
      }
      finish(false, reason || "unsupported");
    }
    return true;
  }

  /* 系统合成通道。onFail 用于"一个字都没读出来"时让上一层换路 */
  function nativeSpeak(text, hooks, finish, onFail) {
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
      if (!live) { onFail("unsupported"); return; }

      var u;
      try { u = buildUtterance(text, voice); }
      catch (e) { onFail("synthesis-failed"); return; }

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
        // 一个字都没读出来 + 属于可兜底的原因 → 交给下一层（录音或系统合成的另一条）
        if (!ok && !started && canFallback(reason)) { onFail(reason); return; }
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

  /* ---------- 整句朗读（长对话听写用） ----------
   * 单词走有声录音，整句只能走系统合成：有道那类录音接口只收词条，读不了整句。
   * 所以单独开一条路径，不复用 speak() —— speak() 的兜底链是「录音 → 合成」，
   * 对句子没意义，硬套会先请求一个注定失败的音频地址，白等一轮。
   * rate 可调：听写时慢一点听得清，但别太慢，太慢会丢掉连读，练不出真听力。 */
  var SENT_SPEED = 0.9;

  function speakSentence(text, opts) {
    opts = opts || {};
    var rate = typeof opts.rate === "number" ? opts.rate : SENT_SPEED;
    var str = String(text == null ? "" : text).trim();
    var done = once(function (ok, reason) {
      if (opts.onDone) opts.onDone(ok, reason || "");
    });
    if (!str) { done(false, "empty"); return false; }

    var s = getSynth();
    if (!s || !hasCtor()) { done(false, "unsupported"); return false; }

    bindVoices();
    var voice = pickVoice();
    stopAudio();               // 别让单词录音和整句抢着说话
    resumeIfPaused(s);
    try { s.cancel(); } catch (e) {}
    // cancel 是异步的，紧接着 speak 会被吞（iOS / 安卓同一个毛病）
    setTimeout(start, 60);
    return true;

    function start() {
      var live = getSynth();
      if (!live) { done(false, "unsupported"); return; }
      var u;
      try { u = buildUtterance(str, voice); } catch (e) { done(false, "synthesis-failed"); return; }
      u.rate = rate;

      var started = false, settled = false, watch = null;
      // 按字符数估上限：英文合成大约 12 字符 / 秒，留 3 倍余量，
      // 免得长句读到一半被 8 秒的老看门狗掐断。
      var budget = Math.min(60000, Math.max(8000, Math.round(str.length / 12 * 3000)));

      u.onstart = function () {
        started = true;
        if (opts.onStart) opts.onStart();
      };
      u.onend = function () {
        if (settled) return;
        settled = true;
        clearTimeout(watch);
        done(true);
      };
      u.onerror = function (ev) {
        if (settled) return;
        settled = true;
        clearTimeout(watch);
        done(false, (ev && ev.error) || "synthesis-failed");
      };

      try { live.speak(u); }
      catch (e) { if (!settled) { settled = true; done(false, "synthesis-failed"); } return; }

      watch = setTimeout(function () {
        if (settled) return;
        settled = true;
        // 到点还没收到 onend：已经出过声就算成功（有的引擎根本不派 onend）
        done(started, started ? "" : "not-started");
      }, budget);
      if (watch && typeof watch.unref === "function") watch.unref();
    }
  }

  /* ---------- 长对话：按气口分段朗读 ----------
   * 系统合成把整句当一条直线念，所以听着机器。做法是把句子交给 VQProsody 排成
   * 几个「一口气」的片段（谁说的、什么语气、哪里停多久），这里逐段念、按 pause 留白。
   * 关键一条：段与段之间**绝不 cancel**，cancel 会把下一个音吞掉，句子会碎成一截一截。 */
  var dlgToken = 0;
  var DLG_PREF = "vq_dlg_voice";

  function englishVoices() {
    var s = getSynth();
    var list = [];
    try { if (s && typeof s.getVoices === "function") list = s.getVoices() || []; } catch (e) {}
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].lang || "").replace("_", "-").toLowerCase().indexOf("en") === 0) out.push(list[i]);
    }
    return out;
  }

  function findVoice(name) {
    var list = englishVoices();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }

  function dialogueVoices() {
    var list = englishVoices();
    var P = global.VQProsody;
    if (!P) return { a: list[0] || null, b: list[0] || null, distinct: false, options: [] };
    var chosen = null;
    try { chosen = global.localStorage && global.localStorage.getItem(DLG_PREF); } catch (e) {}
    var pick = P.pickVoices(list, chosen);
    return {
      a: pick.a ? findVoice(pick.a.name) : null,
      b: pick.b ? findVoice(pick.b.name) : null,
      distinct: pick.distinct,
      options: pick.options
    };
  }

  function stopDialogue() {
    dlgToken++;
    var s = getSynth();
    try { if (s) s.cancel(); } catch (e) {}
    stopAudio();
  }

  /**
   * 念一句台词（可多段）。
   * @param {string} text
   * @param {{speaker?:string, speed?:number, onPlan?:Function, onSegment?:Function,
   *          onStart?:Function, onDone?:Function}} opts
   */
  function speakDialogue(text, opts) {
    opts = opts || {};
    var str = String(text == null ? "" : text).trim();
    var token = 0;
    var finish = once(function (ok, reason) {
      if (token !== dlgToken) return; // 已经被新的播放/停止取代，别再回写 UI
      if (opts.onDone) opts.onDone(ok, reason || "");
    });

    if (!str) { finish(false, "empty"); return false; }
    var s = getSynth();
    if (!s || !hasCtor()) { finish(false, "unsupported"); return false; }

    bindVoices();
    var P = global.VQProsody;
    var plan = P
      ? P.planLine(str, { speaker: opts.speaker, speed: opts.speed })
      : { speaker: opts.speaker === "B" ? "B" : "A", segments: [{ text: str, rate: 1, pitch: 1, pause: 0, final: true }], emotion: {} };
    if (opts.onPlan) { try { opts.onPlan(plan); } catch (e) {} }

    var voices = dialogueVoices();
    var voice = plan.speaker === "B" ? (voices.b || voices.a) : voices.a;

    token = ++dlgToken;
    stopAudio();                 // 单词录音别和整句抢着说话
    resumeIfPaused(s);

    var busy = false;
    try { busy = !!(s.speaking || s.pending); } catch (e) {}
    if (busy) {
      try { s.cancel(); } catch (e) {}
      setTimeout(function () { if (token === dlgToken) chain(); }, 60);
    } else {
      chain();                   // 空闲时同步进入，保住 iOS 的手势上下文
    }
    return true;

    function chain() {
      var i = 0;
      step();

      function step() {
        if (token !== dlgToken) return;
        if (i >= plan.segments.length) { finish(true); return; }
        var seg = plan.segments[i];
        var live = getSynth();
        if (!live) { finish(false, "unsupported"); return; }

        var u;
        try { u = buildUtterance(seg.text, voice); }
        catch (e) { finish(false, "synthesis-failed"); return; }
        u.rate = seg.rate;
        u.pitch = seg.pitch;

        var started = false, settled = false, watch = null, myIndex = i;
        if (opts.onSegment) { try { opts.onSegment(myIndex, plan.segments.length); } catch (e) {} }

        u.onstart = function () {
          started = true;
          if (myIndex === 0 && opts.onStart) { try { opts.onStart(); } catch (e) {} }
        };
        u.onend = function () {
          if (settled) return;
          settled = true;
          clearTimeout(watch);
          next();
        };
        u.onerror = function (ev) {
          if (settled) return;
          settled = true;
          clearTimeout(watch);
          // 这一段已经出过声就继续往下读，别因为一个报错让整句哑掉
          if (started) { next(); return; }
          finish(false, (ev && ev.error) || "synthesis-failed");
        };

        function next() {
          i++;
          if (i >= plan.segments.length) { finish(true); return; }
          var t = setTimeout(step, seg.pause || 0);
          if (t && typeof t.unref === "function") t.unref();
        }

        try { live.speak(u); }
        catch (e) { finish(false, "synthesis-failed"); return; }

        // 有的引擎不派 onend：按字数估一个上限，到点就当这段读完了
        var budget = Math.max(2200, Math.round(seg.text.length / 11 * 1900));
        watch = setTimeout(function () {
          if (settled) return;
          settled = true;
          if (started) { next(); return; }
          finish(false, "not-started");
        }, budget);
        if (watch && typeof watch.unref === "function") watch.unref();
      }
    }
  }

  // 试听某个音色（换声音面板用）：单段、原速，不套任何语气
  function previewVoice(name, text) {
    var s = getSynth();
    if (!s || !hasCtor()) return false;
    var v = findVoice(name);
    if (!v) return false;
    var u;
    try { u = buildUtterance(String(text || "Hello, how can I help you today?"), v); }
    catch (e) { return false; }
    u.rate = 1;
    u.pitch = 1;
    var token = ++dlgToken;
    try { s.cancel(); } catch (e) {}
    setTimeout(function () {
      if (token !== dlgToken) return;
      try { s.speak(u); } catch (e) {}
    }, 60);
    return true;
  }

  function setDialogueVoice(name) {
    try { global.localStorage.setItem(DLG_PREF, String(name || "")); } catch (e) {}
    return name;
  }
  function getDialogueVoice() {
    var v = null;
    try { v = global.localStorage && global.localStorage.getItem(DLG_PREF); } catch (e) {}
    return v || "";
  }

  /* ---------- 诊断（"为什么没声音"找原因） ---------- */
  /* 预取录音：题目一出现就把音频下到缓存里，点喇叭时不用等那 300ms */
  function prefetch(text) {
    if (pref() === "native") return;
    var w = String(text || "").trim();
    if (!w || typeof global.Audio !== "function") return;
    try {
      var a = new global.Audio(audioSources()[0](w));
      a.preload = "auto";
      a.muted = true;
      if (a.load) a.load();
    } catch (e) {}
  }

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
      mode: pref() === "native" ? "native" : "audio",
      pref: pref(),
      prefName: prefName(),
      nativeSupported: supported(),
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
    speakSentence: speakSentence,
    speakDialogue: speakDialogue,
    stopDialogue: stopDialogue,
    previewVoice: previewVoice,
    dialogueVoices: dialogueVoices,
    setDialogueVoice: setDialogueVoice,
    getDialogueVoice: getDialogueVoice,
    stop: stopAudio,
    diagnose: diagnose,
    reasonText: reasonText,
    pickVoice: pickVoice,
    voices: VOICES.map(function (v) { return { id: v.id, name: v.name }; }),
    prefetch: prefetch,
    setVoice: setPref,
    get voice() { return pref(); },
    get voiceName() { return prefName(); },
    // 下一个风格（用来做"点一下换个声音"）
    nextVoice: function () {
      var cur = pref();
      var i = 0;
      for (var k = 0; k < VOICES.length; k++) if (VOICES[k].id === cur) i = k;
      return setPref(VOICES[(i + 1) % VOICES.length].id);
    },
    get supported() { return supported(); },
    get mode() { return pref() === "native" ? "native" : "audio"; },
    get isWeChat() { return /MicroMessenger/i.test(global.navigator ? global.navigator.userAgent : ""); }
  };
})(typeof window !== "undefined" ? window : this);
