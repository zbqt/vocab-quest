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
    stopBuffer();   // 内存那一路和媒体元素那一路都可能是"正在响"的那个
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
   * 水声，比原速难听得多。有道那条录音本身是慢速清晰发音，已经是"背单词该有的速度"。
   *
   * 所以这里必须是 1。原来是 0.8，本意是让机械音听清，实际后果是：
   * 有录音时是正常速度、退化成系统合成时突然慢 20% —— 两条音源速度割裂，
   * 用户听到的是"怎么突然变慢了"，而不是"变清楚了"。统一到原速。 */
  var SPEED = 1;

  /* 本次会话里系统合成已经彻底失败过（一个音都没读出来）。
   * 设备没装英文语音包时，每题都要白等 2.2 秒才降级，连着几题就是"怎么这么卡"。
   * 记住之后直接跳过这一路，刷新页面即重置 —— 装了语音包的人刷新就能恢复。 */
  var nativeDead = false;

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
        nativeDead = false;   // 换了音色就重新试一次：用户可能刚装好系统语音包
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
  /* ---------- 站内录音（离线可用的那一路） ----------
   * 以前单词发音是**热链**有道的接口：每点一次喇叭就联网一次。断网就必然失败，
   * 只能退回设备合成 —— 而国产安卓机大多没装英文语音包，等于离线是哑的。
   *
   * 现在同一批录音由 tools/fetch-word-audio.mjs 预渲染到 audio/w/<前两字母>/<词>.mp3，
   * 同源、无防盗链、service worker 缓存优先。播过一次的词，以后断网也在。
   * 代价是这 6 千多个文件**不进**预缓存（全量 28MB，首次安装不该下这么多），
   * 只按需下载：谁播过谁就在本地。
   *
   * 只有纯字母的词才有本地文件；词组、带连字符的词条走在线那一路。 */
  var LOCAL_DIR = "audio/w/";

  function localSrc(word) {
    var w = String(word == null ? "" : word).trim().toLowerCase();
    // 与生成脚本的规则必须一致：两边都只认 2~15 个纯小写字母
    if (!/^[a-z]{2,15}$/.test(w)) return "";
    return LOCAL_DIR + w.slice(0, 2) + "/" + w + ".mp3";
  }

  /* ---------- 预解码通道：让「点一下」变成「立刻响」 ----------
   *
   * 走 <audio> 播一个词，点下去之后浏览器要做完这一串才出声：
   *   唤醒 Service Worker → 打开缓存 → 在 6 千条索引里查 → 读盘 → 建媒体解码器 → 解 mp3
   * 在线时这一串还能被网络掩盖一部分，离线时它一步都省不掉 ——
   * 表现就是"离线之后点一下，等好久才响"。
   *
   * 但这批词是**提前就知道的**：进一个关卡时，这一组的 12~15 个词已经定下来了；
   * 复习、听写也一样。既然如此，就没有理由等手指按下去才开始干活。
   *
   * 做法：用 Web Audio 把它们提前解成 AudioBuffer 存内存，播放时用
   * AudioBufferSourceNode —— start() 之后几十毫秒出声，不碰网络、不碰 SW、不解码。
   * 解压本身在后台线程，不占主线程，也不会卡住页面。
   *
   * 兜底层不变：没解到（词组、没缓存、浏览器不支持）就还走原来那条 <audio>。
   */
  var bufCache = {};      // 站内地址 -> AudioBuffer
  var bufOrder = [];      // 最近用过的顺序，用来淘汰
  var bufBytes = 0;
  var BUF_MAX_ITEMS = 80;                    // 一组题 15 个词，80 个够好几组来回
  var BUF_MAX_BYTES = 16 * 1024 * 1024;      // 解码后是 float32，比 mp3 大二十来倍
  var decoding = {};      // 站内地址 -> 正在下/正在解，避免同一个词排队两次
  var decQueue = [], decActive = 0, DEC_PAR = 3;  // 并发解码：3 路，够快又不抢主线程
  var actx = null;
  var currentNode = null; // 正在播的 AudioBufferSourceNode

  function getCtx() {
    if (actx) return actx;
    var C = null;
    try { C = global.AudioContext || global.webkitAudioContext; } catch (e) {}
    if (!C) return null;
    try { actx = new C(); } catch (e) { actx = null; }
    return actx;
  }

  /* iOS 的 AudioContext 必须在用户手势里 create/resume 过一次，
   * 否则一直是 suspended：start() 干干净净地跑完，一点声音都没有，也不报错。
   * 所以在第一下手势上开一次，之后全程用同一个 ctx。 */
  var unlocked = false;
  function unlock() {
    var c = getCtx();
    if (!c) return;
    try { if (c.state === "suspended" && c.resume) c.resume(); } catch (e) {}
    if (unlocked) return;
    unlocked = true;
    // 播一个 1 采样静音：安卓上这一步能把输出通道真正打开，
    // 省掉首播那两三百毫秒的"设备启动"等待
    try {
      var b = c.createBuffer(1, 1, c.sampleRate || 22050);
      var s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch (e) {}
  }
  function bindUnlock() {
    if (!global.document || typeof global.document.addEventListener !== "function") return;
    var evs = ["pointerdown", "touchend", "mousedown", "keydown"];
    var h = function () {
      unlock();
      for (var i = 0; i < evs.length; i++) {
        try { global.document.removeEventListener(evs[i], h, true); } catch (e) {}
      }
    };
    for (var i = 0; i < evs.length; i++) {
      try { global.document.addEventListener(evs[i], h, { capture: true, passive: true }); } catch (e) {}
    }
  }

  function bufSize(b) {
    if (!b) return 0;
    var ch = b.numberOfChannels || 1;
    var n = b.length || 0;
    return ch * n * 4; // float32
  }

  function putBuf(key, buf) {
    if (!buf) return;
    var ix = bufOrder.indexOf(key);
    if (ix >= 0) bufOrder.splice(ix, 1);
    bufBytes += bufSize(buf) - (bufCache[key] ? bufSize(bufCache[key]) : 0);
    bufCache[key] = buf;
    bufOrder.push(key);
    // 淘汰：先按条数，再按内存。淘汰掉的只是"加速缓存"，不是离线能力 ——
    // 真播的时候还能从本机缓存重新解，只是慢一点。
    while (bufOrder.length > BUF_MAX_ITEMS || (bufBytes > BUF_MAX_BYTES && bufOrder.length > 1)) {
      var old = bufOrder.shift();
      if (!old || old === key) break;
      bufBytes -= bufSize(bufCache[old]);
      delete bufCache[old];
    }
    if (bufBytes < 0) bufBytes = 0;
  }

  function pumpDecode() {
    while (decActive < DEC_PAR && decQueue.length) {
      var job = decQueue.shift();
      decActive++;
      job(function () {
        decActive--;
        pumpDecode();
      });
    }
  }

  /* 把一个词解进内存。返回 false = 这个词进不了内存（词组、没有 ctx、已在队列里） */
  function decodeWord(word) {
    var src = localSrc(word);
    if (!src) return false;
    var c = getCtx();
    if (!c || typeof c.decodeAudioData !== "function") return false;
    if (bufCache[src] || decoding[src]) return false;
    if (typeof global.fetch !== "function") return false;

    decoding[src] = 1;
    decQueue.push(function (done) {
      // 排队期间可能被别的路径解掉了，别重复解
      if (bufCache[src]) { delete decoding[src]; done(); return; }
      var p;
      try { p = global.fetch(src); } catch (e) { delete decoding[src]; done(); return; }
      Promise.resolve(p)
        .then(function (r) { return r && r.ok ? r.arrayBuffer() : null; })
        .then(function (ab) {
          if (!ab) { delete decoding[src]; done(); return; }
          // 老版 Safari 的 decodeAudioData 只收回调、不返回 Promise，两种都兜
          return new Promise(function (res, rej) {
            var ret = null;
            try { ret = c.decodeAudioData(ab, res, rej); } catch (e) { rej(e); return; }
            if (ret && typeof ret.then === "function") ret.then(res, rej);
          });
        })
        .then(function (buf) {
          delete decoding[src];
          if (buf) putBuf(src, buf);
          done();
        })
        .catch(function () {
          // 解不出来就当没这条捷径：播放时照旧走 <audio>，用户不会因此听不到
          delete decoding[src];
          done();
        });
    });
    pumpDecode();
    return true;
  }

  function stopBuffer() {
    var n = currentNode;
    currentNode = null;
    if (!n) return;
    try { n.onended = null; n.stop(0); } catch (e) {}
  }

  /* 从内存放一个词。返回 true 表示"这条路接了"，之后的成功/失败都通过回调给。
   * onFail 用于"接不了"时让上层退回 <audio> —— 比如上下文被系统挂起、resume 被拒。 */
  function playBuffer(word, hooks, finish, onFail) {
    var key = localSrc(word);
    var buf = key && bufCache[key];
    if (!buf) return false;
    var c = getCtx();
    if (!c || typeof c.createBufferSource !== "function") return false;

    var started = false, abandoned = false, node = null, guard = null, waitT = null;

    function begin() {
      if (started || abandoned) return;
      started = true;
      clearTimeout(waitT);
      stopAudio();   // 上一个词还在响就先掐掉：连点两次不该两个声音叠在一起
      try {
        node = c.createBufferSource();
        node.buffer = buf;
        node.connect(c.destination);
        node.onended = function () {
          if (currentNode !== node) return;
          currentNode = null;
          clearTimeout(guard);
          finish(true);
        };
        currentNode = node;
        node.start(0);
      } catch (e) {
        currentNode = null;
        started = false;
        if (onFail) onFail("audio-busy"); else finish(false, "audio-busy");
        return;
      }
      if (hooks && hooks.onStart) hooks.onStart();
      // 极少数环境不派 ended：按长度兜一个底，别让按钮永远停在"播放中"
      guard = setTimeout(function () {
        if (currentNode !== node) return;
        currentNode = null;
        finish(true);
      }, Math.round((buf.duration || 1) * 1000) + 800);
      if (guard && typeof guard.unref === "function") guard.unref();
    }

    if (!c.state || c.state === "running") { begin(); return true; }

    // 切后台回来是什么状态：iOS 叫 "interrupted"，安卓省电模式叫 "suspended"。
    // 不 resume 就直接 start，会安安静静地什么都没有。
    var p = null;
    try { p = c.resume(); } catch (e) {}
    if (p && typeof p.then === "function") {
      p.then(begin, function () {
        if (started || abandoned) return;
        abandoned = true;
        if (onFail) onFail("not-allowed"); else finish(false, "not-allowed");
      });
      // resume 偶尔既不 resolve 也不 reject（页面刚切回来）：700ms 还没动静就交给 <audio>
      waitT = setTimeout(function () {
        if (started || abandoned) return;
        abandoned = true;
        if (onFail) onFail("not-allowed"); else finish(false, "not-allowed");
      }, 700);
      if (waitT && typeof waitT.unref === "function") waitT.unref();
    } else {
      begin();
    }
    return true;
  }

  /* 进一组题时调用：把这组的词提前解进内存。
   * 返回真正排进队列的个数（已被系统合成偏好跳过、或没有 Web Audio 时是 0）。 */
  function preloadWords(words, opts) {
    opts = opts || {};
    if (pref() === "native" && !opts.force) return 0; // 用户明确要系统合成，别占内存
    var c = getCtx();
    if (!c || typeof c.decodeAudioData !== "function") return 0;
    var n = 0;
    for (var i = 0; i < (words || []).length; i++) {
      var w = String(words[i] == null ? "" : words[i]);
      if (!w) continue;
      if (decodeWord(w)) n++;
    }
    return n;
  }

  // 离线判断只用来决定「还要不要浪费一轮去请求外链」。
  // online 事件不可靠（连着 WiFi 但没有出口也会报 true），所以它只做"提前跳过"，不做"禁止"。
  function online() {
    try { return global.navigator ? global.navigator.onLine !== false : true; } catch (e) { return true; }
  }

  function remoteSrc(id) {
    var v = VOICES.filter(function (x) { return x.id === id; })[0];
    return function (w) {
      return "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(w) + "&" + v.src;
    };
  }

  /* 按偏好排出录音源顺序。
   * 选了美音（默认）：站内 → 在线美音 → 在线英音。
   * 选了英音：在线英音打头（用户明确要英音，站内只有美音录音，不能顶替），
   *          离线时才落到站内美音 —— 有声音比口音正宗重要。
   * 离线：外链一个都不排，省掉两次注定失败的请求（每次要等 4 秒看门狗）。 */
  function audioSources() {
    var p = pref();
    var net = online();
    var list = [];
    var local = function (w) { return localSrc(w); };

    if (p === "uk") {
      if (net) list.push(remoteSrc("uk"));
      list.push(local);
      if (net) list.push(remoteSrc("us"));
    } else {
      list.push(local);
      if (net) { list.push(remoteSrc("us")); list.push(remoteSrc("uk")); }
    }
    return list;
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
    var word = String(text).trim();
    if (!word) { finish(false, "empty"); return false; }

    var hasEl = typeof global.Audio === "function";
    if (!hasEl && !getCtx()) { fail("unsupported"); return false; }

    var elementDone = false;
    var cands = [], idx = 0;   // 候选音源与游标：viaElement 里填，playNext 里走

    function fail(reason) { if (onFail) onFail(reason); else finish(false, reason); }

    /* 快路：这个词已经预解码在内存里 → 直接 start()，几十毫秒出声。
     * 走不到就（或走到一半被系统挂起）落到下面的 <audio>，行为和以前一样。 */
    if (playBuffer(word, hooks, finish, viaElement)) return true;
    viaElement();
    return true;

    function viaElement() {
      if (elementDone) return;
      elementDone = true;
      if (!hasEl) { fail("audio-unavailable"); return; }

      // 没预解码到（第一次见这个词）就在这里补一次，下一次点就是"立刻响"
      decodeWord(word);

      // 每一路音源都先算出地址，算不出地址的（比如词组没有站内文件）直接不排进候选，
      // 否则会在一个空 src 上浪费一次重试 —— 手机上就是多等 4 秒。
      var sources = audioSources();
      cands = [];
      for (var s = 0; s < sources.length; s++) {
        var u = sources[s](word);
        if (u) cands.push(u);
      }

      stopAudio();
      idx = 0;
      playNext();
    }

    function playNext() {
      if (idx >= cands.length) { fail("audio-unavailable"); return; }
      var src = cands[idx++];
      // 预取过的元素直接用：否则同一个地址要被请求两次，点下去还得再等一轮
      var a = takePrefetched(src);
      if (!a) {
        try { a = new global.Audio(src); }
        catch (e) { fail("audio-unavailable"); return; }
      }

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
        if (ch === "native" && supported() && !nativeDead) { nativeSpeak(text, hooks, finish, next); return; }
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
        if (!ok && !started && canFallback(reason)) {
          // 手势不足（not-allowed）不算设备没语音，那是一次性上下文问题，别记死
          if (reason !== "unsupported") nativeDead = true;
          onFail(reason);
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
    killCloud();
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

  /* ---------- 整句人声（云端 / 站内 mp3） ----------
   * 设备自带的合成引擎底子太旧，"又平又硬"换断句也救不回来，只能换声源。
   * 这一路直接播合成好的音频，代价是最初要联网取一次。
   *
   * 音源有两条，优先站内：
   *   1. opts.file —— 站点里的 mp3（tools/fetch-audio.mjs 预渲染好的）。
   *      同源、无防盗链、无跨域，手机上最稳，SW 缓存过一次就能离线听。
   *   2. cue.url —— 第三方接口现取。只在站内文件缺失时用。
   * 两条都放不出来才退回 speakDialogue（设备合成）——
   * 但手机上设备合成往往是死的，所以顺序必须是「先本地、再云端、最后设备」。
   *
   * 连挂两次就别再让它每次卡 7 秒：本次会话直接跳过这一路，但**不改用户偏好**，
   * 下次打开页面还会重试（网络可能是临时的）。 */
  var SRC_PREF = "vq_dlg_src";
  var cloudStrikes = 0;
  var cloudAudio = null;

  function killCloud() {
    var a = cloudAudio;
    cloudAudio = null;
    if (!a) return;
    try { a.pause(); } catch (e) {}
    try { a.removeAttribute("src"); a.load(); } catch (e) {}
  }

  function getDialogueSource() {
    var v = null;
    try { v = global.localStorage && global.localStorage.getItem(SRC_PREF); } catch (e) {}
    return v === "device" ? "device" : "cloud";
  }

  function setDialogueSource(src) {
    var v = src === "device" ? "device" : "cloud";
    try { global.localStorage.setItem(SRC_PREF, v); } catch (e) {}
    if (v === "cloud") cloudStrikes = 0;
    return v;
  }

  /**
   * 念一句台词（多段依次播）。
   * @param {string} text
   * @param {{speaker?:string, speed?:number, file?:string, onSegment?:Function,
   *          onStart?:Function, onDone?:Function}} opts
   *        file：这句对应的站内 mp3（同源）。给了就优先播它，缺了再打接口。
   * @returns {boolean} false = 这一路用不了，调用方应当改走设备合成
   */
  function speakCloud(text, opts) {
    opts = opts || {};
    var finish = once(function (ok, reason) {
      if (opts.onDone) opts.onDone(ok, reason || "");
    });
    var S = global.VQSentence;
    if (!S || typeof global.Audio !== "function") { finish(false, "unsupported"); return false; }
    if (cloudStrikes >= 2) { finish(false, "cloud-unavailable"); return false; }

    var str = String(text == null ? "" : text).trim();
    var plan = S.cues(str, { speaker: opts.speaker });
    if (!plan.length) { finish(false, "empty"); return false; }

    var token = ++dlgToken;
    var rate = typeof opts.speed === "number" && opts.speed > 0 ? opts.speed : 1;
    // 站内文件是「整句一个文件」，只有句子没被拆成多段时才可能对得上
    var localFile = opts.file && plan.length === 1 ? opts.file : "";
    // 两句抢着说话比一句听不清更糟：先把设备合成和单词录音都停掉
    try { var synth = getSynth(); if (synth) synth.cancel(); } catch (e) {}
    stopAudio();

    var i = 0, settled = false;
    step();
    return true;

    function bail(reason) {
      if (settled) return;
      settled = true;
      killCloud();
      cloudStrikes++;
      finish(false, reason);
    }

    function step() {
      if (token !== dlgToken || settled) return;
      if (i >= plan.length) { settled = true; killCloud(); finish(true); return; }

      var cue = plan[i];
      if (opts.onSegment) { try { opts.onSegment(i, plan.length); } catch (e) {} }

      // 候选音源：站内文件在前，接口地址在后
      var cands = localFile ? [localFile, cue.url] : [cue.url];
      var started = false;
      attempt(0);

      function attempt(ci) {
        if (token !== dlgToken || settled) return;
        if (ci >= cands.length) { bail(token === dlgToken ? "blocked" : "interrupted"); return; }

        var src = cands[ci];
        // 预取过就直接播那一个：否则同一句会被请求两次，而且点下去还得再等一轮网络
        var a = takePrefetched(src);
        if (!a) {
          try { a = new global.Audio(src); } catch (e) { attempt(ci + 1); return; }
          a.preload = "auto";
        }
        if (cloudAudio && cloudAudio !== a) { try { cloudAudio.pause(); } catch (e) {} }
        cloudAudio = a;
        // 只改速度、不改音高。整句拉伸比单词拉伸宽容得多，但超过 0.85 也开始发糊
        try { a.playbackRate = rate; a.preservesPitch = true; } catch (e) {}

        var done = false;
        // 预算 = 加载余量 + 播放时长。只算加载的话，句子一长就会被自己的看门狗切断
        // （英文朗读约 14 字符/秒，这里按 9 字符/秒估，留足余量当作安全网）
        var budget = 3000 + Math.round(cue.text.length / 9 * 1000) + (i === 0 ? 4000 : 0);
        var watch = setTimeout(function () {
          if (done) return;
          done = true;
          if (started) { next(); return; }
          if (token !== dlgToken) { bail("interrupted"); return; }
          attempt(ci + 1);
        }, budget);
        if (watch && typeof watch.unref === "function") watch.unref();

        // 换源重试时这几个监听还挂在旧元素上，靠 done 兜住，不会重复推进
        function giveUpOrNext() {
          if (started) { next(); return; }
          attempt(ci + 1);
        }

        a.addEventListener("playing", function () {
          if (started) return;
          started = true;
          if (i === 0 && opts.onStart) { try { opts.onStart(); } catch (e) {} }
        });
        a.addEventListener("ended", function () {
          if (done) return;
          done = true;
          clearTimeout(watch);
          next();
        });
        // 有的环境（旧 Safari、部分安卓 WebView）不派发 ended，只派发 timeupdate。
        // 光靠看门狗兜底会让"正在播"一直挂着，所以播到尾巴就自己收。
        a.addEventListener("timeupdate", function () {
          if (done) return;
          var d = 0, c = 0;
          try { d = a.duration || 0; c = a.currentTime || 0; } catch (e) {}
          if (!d || c < d - 0.2) return;
          done = true;
          clearTimeout(watch);
          next();
        });
        a.addEventListener("error", function () {
          if (done) return;
          done = true;
          clearTimeout(watch);
          // 已经出过声才断的，当这一段读完，别让整句哑掉
          giveUpOrNext();
        });

        var p;
        try { p = a.play(); } catch (e) { done = true; clearTimeout(watch); giveUpOrNext(); return; }
        if (p && typeof p.catch === "function") {
          p.catch(function (err) {
            if (done) return;
            done = true;
            clearTimeout(watch);
            // NotAllowedError 是"缺一次点击"，换源也没用，别把两条源都试一遍
            if (err && err.name === "NotAllowedError") { bail("not-allowed"); return; }
            giveUpOrNext();
          });
        }
      }
    }

    function next() {
      if (token !== dlgToken || settled) return;
      var gap = plan[i].gap || 0;
      i++;
      if (gap) setTimeout(step, gap);
      else step();
    }
  }

  /* 预取整句音频：切到某一句就先把声音取下来。
   * 实测首次点播要等近 2 秒（请求 + 解码），预取之后基本是立刻出声 ——
   * 听写本来就要反复听同一句，这 2 秒会重复很多次。
   * 站内 mp3 也一起预取：手机上同源文件虽然快，但第一次仍要读盘 + 解码。 */
  var prefetchCache = {}, prefetchKeys = [];

  // 别让预取无限长：只留最近 24 条地址（一组题 15 个词 + 几句整句，够用）
  function trimPrefetch() {
    while (prefetchKeys.length > 24) {
      var old = prefetchKeys.shift();
      try { delete prefetchCache[old]; } catch (e) {}
    }
  }

  // 取用预取好的元素：取走就删，一次预取只服务一次播放
  function takePrefetched(u) {
    var a = prefetchCache[u];
    if (!a) return null;
    delete prefetchCache[u];
    var ix = prefetchKeys.indexOf(u);
    if (ix >= 0) prefetchKeys.splice(ix, 1);
    try { if (a.error) return null; } catch (e) {}   // 预取时就已经坏了的，别拿来播
    try { a.muted = false; } catch (e) {}            // 预取是静音下载，播之前必须放开
    try { if (a.currentTime) a.currentTime = 0; } catch (e) {}
    return a;
  }

  function prefetchCloud(text, opts) {
    opts = opts || {};
    if (getDialogueSource() !== "cloud") return false;
    var S = global.VQSentence;
    if (!S || typeof global.Audio !== "function") return false;
    var cues = S.cues(text == null ? "" : text, { speaker: opts.speaker });
    if (!cues.length) return false;

    // 候选取法和 speakCloud 保持一致：站内文件在前，接口地址在后
    var urls = [];
    for (var i = 0; i < cues.length; i++) {
      if (i === 0 && opts.file && cues.length === 1) urls.push(opts.file);
      urls.push(cues[i].url);
    }

    var got = false;
    for (var k = 0; k < urls.length; k++) {
      var u = urls[k];
      if (prefetchCache[u]) continue;
      try {
        var a = new global.Audio(u);
        a.preload = "auto";
        a.muted = true;              // 只下载，不出声
        if (a.load) a.load();
        prefetchCache[u] = a;
        prefetchKeys.push(u);
        got = true;
      } catch (e) {}
    }
    // 别让缓存无限长：只留最近 24 条地址
    trimPrefetch();
    return got;
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
  /* 预取录音：题目一出现就先备好，点喇叭时不用等。
   * 两件事都做：① 解进内存（点下去几十毫秒出声，离线尤其明显）；
   *              ② 留一个已开始加载的 <audio> 备用（内存那路不可用时直接接管）。 */
  function prefetch(text) {
    if (pref() === "native") return;
    var w = String(text || "").trim();
    if (!w) return;
    decodeWord(w);
    if (typeof global.Audio !== "function") return;
    // 第一路可能算不出地址（词组没有站内文件、离线时不排外链），别拿空串去建 <audio>
    var src = audioSources()[0](w);
    if (!src || prefetchCache[src]) return;   // 已经备过就别再建一个
    try {
      var a = new global.Audio(src);
      a.preload = "auto";
      a.muted = true;
      if (a.load) a.load();
      prefetchCache[src] = a;
      prefetchKeys.push(src);
      trimPrefetch();
    } catch (e) {}
  }

  /* 批量预取：进来一组题（一个关卡 / 一次复习）就把这组的词音频存到本地。
   * 用 fetch() 而不是 <audio>：目的只是让 service worker 把文件落到 Cache Storage，
   * 不需要解码，几十个词也不会在内存里挂一堆媒体元素。
   * 这是「离线能听」的真正保障 —— 光靠用户一个个点播放，没点过的词离线还是哑的。 */
  function prefetchMany(words, opts) {
    opts = opts || {};
    if (pref() === "native" || !online()) return 0;
    var list = [], seen = {};
    for (var i = 0; i < (words || []).length; i++) {
      var s = localSrc(words[i]);
      // 已经解进内存（或正在解）的词不用再取一次：取它的那次请求已经把文件
      // 落到本机缓存了。否则进关卡时同一批词会被请求两遍。
      if (s && !seen[s] && !bufCache[s] && !decoding[s]) { seen[s] = 1; list.push(s); }
    }
    if (!list.length) return 0;

    var k = 0, left = opts.max || list.length;
    if (left > list.length) left = list.length;

    function next() {
      if (k >= left) { if (opts.onDone) { try { opts.onDone(k); } catch (e) {} } return; }
      var url = list[k++];
      var step = function () { next(); };
      try {
        fetch(url)
          .then(function (r) { return r && r.ok ? r.arrayBuffer() : null; })
          .then(step, step);
      } catch (e) { step(); }
    }
    // 2 路并发：够快，又不至于一进关卡就抢走听力题本身的带宽
    next(); next();
    return left;
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
          // 切回来时 Web Audio 可能是 suspended：不恢复，内存那一路就是"静音播放"
          try { var c = getCtx(); if (c && c.state === "suspended" && c.resume) c.resume(); } catch (e) {}
        }
      });
    }
  } catch (e) {}

  // 第一下手势上把音频输出通道打开（iOS 要求；安卓能省掉首播的设备启动延迟）
  try { bindUnlock(); } catch (e) {}

  global.VQSpeech = {
    speak: speak,
    speakSentence: speakSentence,
    speakDialogue: speakDialogue,
    speakCloud: speakCloud,
    stopDialogue: stopDialogue,
    getDialogueSource: getDialogueSource,
    setDialogueSource: setDialogueSource,
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
    prefetchMany: prefetchMany,
    // 把这组词提前解进内存：进关卡 / 开一组复习时调一次，点播放就几乎零等待
    preloadWords: preloadWords,
    unlockAudio: unlock,
    // 站内录音地址（纯函数，便于单测）：词组/非法词条返回空串，表示只能走在线那一路
    localSrc: localSrc,
    prefetchCloud: prefetchCloud,
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
    // 设备合成这条路通不通。国产安卓浏览器常常连 speechSynthesis 都没有，
    // 调用方据此决定"要不要一开始就用人声"，而不是等用户点了播放才发现没声音。
    get deviceSupported() { return supported(); },
    get mode() { return pref() === "native" ? "native" : "audio"; },
    get isWeChat() { return /MicroMessenger/i.test(global.navigator ? global.navigator.userAgent : ""); }
  };
})(typeof window !== "undefined" ? window : this);
