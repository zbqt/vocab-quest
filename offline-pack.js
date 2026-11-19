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

  /* 把「离线发音包」面板挂到容器里，返回控制器 { refresh, busy }。
   *
   * 首页和闯关页都要这个入口，但两处各写一份文案与状态机，迟早一处改成
   * 「下载中」另一处还写着「下载」——所以 DOM 与状态机只留这一份。
   * 样式在 ui.css 的 .vq-pack 段（四个页面都加载它）。
   *
   * 不支持 Cache API 时返回 null，并把容器换成一句实话：不支持的浏览器
   * 留一个点了没反应的按钮，比不显示更糟。 */
  function mountPack(host) {
    if (!host) return null;
    var st = { words: null, have: 0, busy: false, stop: false, failed: 0 };

    if (!hasCache()) {
      host.innerHTML =
        '<p class="vq-pack-fallback">这个浏览器不支持离线缓存，换 Chrome / Edge / Safari 才能下载离线发音包。</p>';
      return null;
    }

    host.classList.add("vq-pack");
    host.innerHTML =
      '<div class="vq-pack-main">' +
        '<h3 class="vq-pack-title">📥 离线发音包</h3>' +
        '<p class="vq-pack-desc"></p>' +
        '<div class="vq-pack-bar" role="progressbar" aria-label="录音下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><i></i></div>' +
        '<p class="vq-pack-meta" role="status" aria-live="polite"></p>' +
      '</div>' +
      '<button class="vq-pack-btn" type="button">…</button>';

    var desc = host.querySelector(".vq-pack-desc");
    var bar = host.querySelector(".vq-pack-bar");
    var fill = bar.querySelector("i");
    var meta = host.querySelector(".vq-pack-meta");
    var btn = host.querySelector(".vq-pack-btn");

    function mb(n) { return Math.round(n * 4.3 / 1024); }
    function num(n) { try { return n.toLocaleString("zh-CN"); } catch (e) { return String(n); } }

    function paint() {
      var total = st.words ? st.words.length : 0;
      var pct = total ? Math.min(100, Math.round(st.have / total * 100)) : 0;

      bar.hidden = !st.busy;
      fill.style.width = st.busy ? Math.max(2, pct) + "%" : "0%";
      bar.setAttribute("aria-valuenow", String(pct));

      if (st.busy) {
        btn.textContent = "停止";
        btn.disabled = false;
        btn.setAttribute("data-act", "stop");
        desc.textContent = "正在往本机存录音，别关这个页面";
        meta.textContent = "已存 " + num(st.have) + " / " + (total ? num(total) : "?") +
          " 个 · 中途退出也不要紧，再点一次只补缺的";
        return;
      }
      if (total && st.have >= total) {
        btn.textContent = "删除";
        btn.disabled = false;
        btn.setAttribute("data-act", "clear");
        desc.textContent = "全部录音已存到本机（四本书去重），断网也能听";
        meta.textContent = total + " 个词 · 约 " + mb(total) + "MB · 断网也能听任何词";
        return;
      }
      btn.textContent = st.failed ? "重试缺的" : "下载到本机";
      btn.disabled = false;
      btn.setAttribute("data-act", "download");
      desc.textContent = "把四本书去重后的全部单词录音一次存到本机，断网时任何一个词都能听";
      meta.textContent = st.have
        ? "本机已有 " + num(st.have) + " 个词" + (total ? " / " + num(total) : "") + " · 继续下载只补缺的"
        : "四本书去重后约 6,400 个词、共约 27MB，建议在 Wi-Fi 下进行";
    }

    function run() {
      if (st.busy || !st.words) return;
      st.busy = true; st.stop = false; st.failed = 0; paint();
      download(st.words, {
        concurrency: 4,
        shouldStop: function () { return st.stop; },
        onProgress: function (p) { st.have = p.skipped + p.done; paint(); }
      }).then(function (r) {
        st.busy = false; st.stop = false;
        return scan().then(function (h) {
          st.have = Object.keys(h).length;
          st.failed = (r && r.failed) ? r.failed.length : 0;
          paint();
          if (st.failed) {
            meta.textContent = "还有 " + st.failed + " 个没下成功，再点一次只补这些";
          }
        });
      }).catch(function (e) {
        st.busy = false; st.stop = false;
        paint();
        meta.textContent = "下载失败：" + ((e && e.message) || "网络问题") + " · 联网后再点一次";
      });
    }

    btn.addEventListener("click", function () {
      var act = btn.getAttribute("data-act");

      if (act === "stop") {
        st.stop = true;
        btn.textContent = "正在停止…";
        btn.disabled = true;
        return;
      }

      if (act === "clear") {
        if (typeof confirm === "function" &&
            !confirm("删除本机已存的单词录音？之后断网时又只能靠系统语音了。")) return;
        st.busy = true; paint();
        clear().then(scan).then(function (h) {
          st.have = Object.keys(h).length;
          st.busy = false; st.failed = 0; paint();
          meta.textContent = "本地录音已删除，腾出的空间归系统";
        }).catch(function () {
          st.busy = false; paint();
          meta.textContent = "删除失败，刷新页面后再试";
        });
        return;
      }

      // 下载：先看清单在不在手上，第一次点才去拉那 61KB
      if (st.words) return run();
      st.busy = true;
      btn.disabled = true;
      btn.textContent = "准备中…";
      desc.textContent = "正在读取录音清单…";
      loadManifest().then(function (w) {
        st.busy = false;
        st.words = w;
        run();
      }).catch(function () {
        st.busy = false;
        paint();
        meta.textContent = "清单读不出来，联网后刷新页面再试";
      });
    });

    scan().then(function (h) { st.have = Object.keys(h).length; paint(); })
      .catch(function () { paint(); });

    return {
      refresh: function () {
        return scan().then(function (h) { st.have = Object.keys(h).length; paint(); });
      },
      isBusy: function () { return st.busy; }
    };
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
    mountPack: mountPack,
    supported: hasCache
  };
});
