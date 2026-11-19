/* 离线发音包：把 6,369 个单词录音一次性存进本机缓存。
 *
 * 为什么需要它：平时录音是「用到哪个存哪个」，这覆盖了「今天要背的词」，
 * 但覆盖不了「离线状态下第一次进一个新关卡」—— 那时候一个都没存过，
 * 全部退化成系统合成（国产安卓常常连英文语音包都没装，等于哑的）。
 *
 * 这里不依赖 Service Worker 是否已经接管：直接开同名缓存写。
 * 所以 cache 名必须和 sw.js 的 AUDIO_CACHE 一致，改一处漏一处就会变成
 * 「下载了但播放时读不到」——test/offline-pack.test.mjs 守着这个一致性。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VQOffline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var CACHE = "vq-audio-v1";          // 必须与 sw.js 的 AUDIO_CACHE 相同
  var MANIFEST = "audio-manifest.json";
  var PREFIX = "audio/w/";

  function hasCache() {
    return typeof caches !== "undefined" && caches && typeof caches.open === "function";
  }

  /* 词形 → 站内路径。规则与 tts.js 的 localSrc 一致（只认纯小写字母）。 */
  function pathOf(word) {
    var w = String(word || "").trim().toLowerCase();
    if (w.length < 2 || w.length > 15 || !/^[a-z]+$/.test(w)) return "";
    return PREFIX + w.slice(0, 2) + "/" + w + ".mp3";
  }

  /* 已经在缓存里的站内录音，返回 { 词: true }。
   * 用一次 keys() 取全量再比对，而不是几千次 match() —— 后者在手机上要好几秒。 */
  function scan() {
    if (!hasCache()) return Promise.resolve({});
    return caches.open(CACHE).then(function (c) {
      return c.keys();
    }).then(function (reqs) {
      var set = {};
      for (var i = 0; i < reqs.length; i++) {
        var p = "";
        try { p = new URL(reqs[i].url).pathname; } catch (e) { continue; }
        var at = p.indexOf(PREFIX);
        if (at < 0) continue;
        var tail = p.slice(at + PREFIX.length);           // ab/able.mp3
        var name = tail.slice(tail.lastIndexOf("/") + 1);
        if (name.slice(-4) === ".mp3") set[name.slice(0, -4)] = true;
      }
      return set;
    });
  }

  function loadManifest() {
    return fetch(MANIFEST, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("清单读取失败 " + r.status);
        return r.json();
      })
      .then(function (d) {
        var words = (d && d.words) || [];
        if (!words.length) throw new Error("清单是空的");
        return words;
      });
  }

  /* 下载缺失的部分。可反复调用：已有的直接跳过，天然断点续传。
   * opts: { onProgress({done,total,failed,skipped}), concurrency, shouldStop() } */
  function download(words, opts) {
    opts = opts || {};
    if (!hasCache()) return Promise.reject(new Error("这台设备不支持离线缓存"));

    var conc = opts.concurrency || 4;
    var shouldStop = opts.shouldStop || function () { return false; };
    var queue = [], failed = [], done = 0, total = 0, skipped = 0;

    return scan().then(function (have) {
      for (var i = 0; i < words.length; i++) {
        var p = pathOf(words[i]);
        if (!p) continue;
        if (have[words[i]]) { skipped++; continue; }
        queue.push(p);
      }
      total = queue.length;
      if (opts.onProgress) opts.onProgress({ done: 0, total: total, failed: 0, skipped: skipped });
      if (!total) return { done: 0, total: 0, failed: [], skipped: skipped };

      return caches.open(CACHE).then(function (cache) {
        var cursor = 0;

        function worker() {
          if (shouldStop() || cursor >= queue.length) return Promise.resolve();
          var url = queue[cursor++];
          // 单个失败不中断整批：网络抖一下不该让用户从头再来
          return fetch(url)
            .then(function (r) {
              if (!r || !r.ok) throw new Error(String(r && r.status));
              return cache.put(url, r);
            })
            .then(function () {
              done++;
              if (opts.onProgress && done % 20 === 0) {
                opts.onProgress({ done: done, total: total, failed: failed.length, skipped: skipped });
              }
            })
            .catch(function () {
              failed.push(url);
            })
            .then(worker);
        }

        var runners = [];
        for (var k = 0; k < conc; k++) runners.push(worker());
        return Promise.all(runners).then(function () {
          if (opts.onProgress) {
            opts.onProgress({ done: done, total: total, failed: failed.length, skipped: skipped });
          }
          return { done: done, total: total, failed: failed, skipped: skipped };
        });
      });
    });
  }

  /* 只删单词录音，整句对话音频留着 —— 用户点「删除」是想省空间，不是想废掉听写。 */
  function clear() {
    if (!hasCache()) return Promise.resolve(0);
    return caches.open(CACHE).then(function (c) {
      return c.keys().then(function (reqs) {
        var hits = reqs.filter(function (r) {
          try { return new URL(r.url).pathname.indexOf(PREFIX) >= 0; } catch (e) { return false; }
        });
        return Promise.all(hits.map(function (r) { return c.delete(r); })).then(function () {
          return hits.length;
        });
      });
    });
  }

  return {
    CACHE: CACHE,
    MANIFEST: MANIFEST,
    PREFIX: PREFIX,
    pathOf: pathOf,
    scan: scan,
    loadManifest: loadManifest,
    download: download,
    clear: clear,
    supported: hasCache
  };
});
