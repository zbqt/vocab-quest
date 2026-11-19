/* Vocab Quest 离线缓存
 *
 * 三个缓存分区，各有各的寿命，别混在一起：
 *   1. 壳（VERSION）—— 页面、脚本、词库。跟着版本号走，发新版整体换掉。
 *   2. 录音（AUDIO_CACHE）—— 单词与整句 mp3。**升级时不删**。
 *      这 6 千多个单词录音是用户一个个攒下来的（谁播过、谁预热过，谁就在本地），
 *      跟着版本号一起清掉，等于每次更新都把「离线能听」重新归零 —— 这是踩过的坑。
 *   3. 其它 —— 同源 GET 一律缓存优先，顺手更新。
 *
 * 发布新版只需把 VERSION 加一。
 */
const VERSION = "vq-v29";
const AUDIO_CACHE = "vq-audio-v1";

const ASSETS = [
  "./",
  "./ui.css",
  "./index.html",
  "./words.html",
  "./game.html",
  "./listening.html",
  "./prosody.js",
  "./sentence-audio.js",
  "./dictation.js",
  "./zh-match.js",
  "./offline-pack.js",
  "./sw-client.js",
  "./dialogues.js",
  "./engine.js",
  "./fsrs.js",
  "./grammar.js",
  "./tts.js",
  "./stats.js",
  "./cloud-sync.js",
  "./vocab.js",
  "./vocab_c6.js",
  "./vocab_cz.js",
  "./vocab_gz.js",
  "./manifest.webmanifest",
  "./icons/icon-32.png",
  "./icons/icon-64.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon-180.png"
];

/* 整句人声（长对话听写）。总共 1MB 出头，值得一装就下 ——
   听写是「离线最该能用」的功能：它靠的就是反复听同一句。
   单词录音相反，6 千多个 / 28MB，绝不预装（见 tts.js 的 localSrc 注释）。 */
const SENTENCE_AUDIO = [
  "./audio/cafe/0.mp3",
  "./audio/cafe/1.mp3",
  "./audio/cafe/2.mp3",
  "./audio/cafe/3.mp3",
  "./audio/cafe/4.mp3",
  "./audio/cafe/5.mp3",
  "./audio/directions/0.mp3",
  "./audio/directions/1.mp3",
  "./audio/directions/2.mp3",
  "./audio/directions/3.mp3",
  "./audio/directions/4.mp3",
  "./audio/directions/5.mp3",
  "./audio/weekend/0.mp3",
  "./audio/weekend/1.mp3",
  "./audio/weekend/2.mp3",
  "./audio/weekend/3.mp3",
  "./audio/weekend/4.mp3",
  "./audio/weekend/5.mp3",
  "./audio/courses/0.mp3",
  "./audio/courses/1.mp3",
  "./audio/courses/2.mp3",
  "./audio/courses/3.mp3",
  "./audio/courses/4.mp3",
  "./audio/courses/5.mp3",
  "./audio/library/0.mp3",
  "./audio/library/1.mp3",
  "./audio/library/2.mp3",
  "./audio/library/3.mp3",
  "./audio/library/4.mp3",
  "./audio/library/5.mp3",
  "./audio/apartment/0.mp3",
  "./audio/apartment/1.mp3",
  "./audio/apartment/2.mp3",
  "./audio/apartment/3.mp3",
  "./audio/apartment/4.mp3",
  "./audio/apartment/5.mp3",
  "./audio/dorm/0.mp3",
  "./audio/dorm/1.mp3",
  "./audio/dorm/2.mp3",
  "./audio/dorm/3.mp3",
  "./audio/dorm/4.mp3",
  "./audio/dorm/5.mp3",
  "./audio/parttime/0.mp3",
  "./audio/parttime/1.mp3",
  "./audio/parttime/2.mp3",
  "./audio/parttime/3.mp3",
  "./audio/parttime/4.mp3",
  "./audio/parttime/5.mp3",
  "./audio/interview/0.mp3",
  "./audio/interview/1.mp3",
  "./audio/interview/2.mp3",
  "./audio/interview/3.mp3",
  "./audio/interview/4.mp3",
  "./audio/interview/5.mp3",
  "./audio/groupwork/0.mp3",
  "./audio/groupwork/1.mp3",
  "./audio/groupwork/2.mp3",
  "./audio/groupwork/3.mp3",
  "./audio/groupwork/4.mp3",
  "./audio/groupwork/5.mp3",
  "./audio/doctor/0.mp3",
  "./audio/doctor/1.mp3",
  "./audio/doctor/2.mp3",
  "./audio/doctor/3.mp3",
  "./audio/doctor/4.mp3",
  "./audio/doctor/5.mp3",
  "./audio/doctor/6.mp3",
  "./audio/flight/0.mp3",
  "./audio/flight/1.mp3",
  "./audio/flight/2.mp3",
  "./audio/flight/3.mp3",
  "./audio/flight/4.mp3",
  "./audio/flight/5.mp3",
  "./audio/flight/6.mp3"
];

/* 打开缓存这件事不必每次请求都做一遍。手机上 open() 是一次异步的索引查找，
 * 点一下喇叭就要为它等几十毫秒 —— 而一个 4.5KB 的录音根本不需要这个开销。
 * 把 Promise 记下来复用，activate 时清掉（换版本后要重新指向新分区）。 */
let shellP = null, audioP = null;
function shellCache() { return shellP || (shellP = caches.open(VERSION)); }
function audioCache() { return audioP || (audioP = caches.open(AUDIO_CACHE)); }

/* 媒体元素（尤其 iOS / 安卓 Chrome）几乎一定会带 Range 头来取音频。
 * 以前一律把整个 200 响应丢回去：Chrome 能凑合播，iOS 会当作"不支持拖动"
 * 反复重试甚至直接判定加载失败 —— 表现是点了没声音、或者要等很久。
 * 这里按 Range 切一刀回 206，让媒体栈一次就拿到它要的字节。
 * 顺带的好处：以后要拖动进度条也有真正的支持。 */
function partialResponse(req, res) {
  const range = req.headers.get("range");
  if (!range) return Promise.resolve(res);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) return Promise.resolve(res);
  const hasStart = m[1] !== "", hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return Promise.resolve(res);

  return res
    .clone()
    .arrayBuffer()
    .then((ab) => {
      const size = ab.byteLength;
      let start = hasStart ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
      let end = hasStart ? (hasEnd ? parseInt(m[2], 10) : size - 1) : size - 1;
      if (start < 0) start = 0;
      if (end >= size || end < 0) end = size - 1;
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          statusText: "Range Not Satisfiable",
          headers: { "Content-Range": "bytes */" + size }
        });
      }
      const chunk = ab.slice(start, end + 1);
      const headers = new Headers(res.headers);
      headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
      headers.set("Content-Length", String(chunk.byteLength));
      headers.set("Accept-Ranges", "bytes");
      // 缓存里存的是解压后的字节，别让浏览器再按压缩格式解一次
      headers.delete("Content-Encoding");
      headers.delete("Content-Length-Original");
      return new Response(chunk, { status: 206, statusText: "Partial Content", headers });
    })
    .catch(() => res);
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const core = await caches.open(VERSION);
      // 逐个加，单个 404 不至于让整次安装失败
      await Promise.all(ASSETS.map((u) => core.add(u).catch(() => null)));
      const aud = await caches.open(AUDIO_CACHE);
      await Promise.all(SENTENCE_AUDIO.map((u) => aud.add(u).catch(() => null)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // 只留当前壳 + 录音缓存；录音缓存跨版本保留
        Promise.all(keys.filter((k) => k !== VERSION && k !== AUDIO_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => {
        shellP = null;   // 换版本了，别再用旧分区的句柄
        audioP = null;
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外链一律不接管

  // 录音：缓存优先，命中就直接给。断网时这是唯一还活着的音源。
  if (url.pathname.indexOf("/audio/") >= 0) {
    e.respondWith(
      audioCache().then((c) =>
        c.match(req).then((hit) => {
          if (hit) return partialResponse(req, hit);
          /* 没命中就去取。注意这里**故意不带 Range**：
           * 媒体元素几乎是带 Range 来的，照着它的头去取只会拿回 206 半截 ——
           * 半截不能存（存进去以后每次播都是坏的），于是这个文件永远进不了本机，
           * 下次断网照样要等网络失败。
           * 所以按「完整文件」取一次（一个词 4.5KB），存进缓存，再在本地切片给客户端。 */
          const full = new Request(req.url, {
            method: "GET",
            credentials: req.credentials || "same-origin"
          });
          return fetch(full).then((res) => {
            // 只存完整的 200：半截响应存进去，以后每次播都是坏的
            if (res.ok && res.status === 200 && res.type === "basic") {
              c.put(req, res.clone()).catch(() => {});
            }
            return partialResponse(req, res);
          });
        })
      )
    );
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          shellCache().then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          // ignoreSearch 是必须的：页面地址常带 ?cat=cet4&act=daily 这类参数，
          // 而预缓存里存的是不带参数的 ./game.html。按完整 URL 匹配必然落空，
          // 结果是断网打开深层链接会掉到首页 —— 看起来像"离线打不开这一页"。
          shellCache()
            .then((c) => c.match(req, { ignoreSearch: true }))
            .then((hit) => hit || shellCache().then((c) => c.match("./index.html")))
        )
    );
    return;
  }

  e.respondWith(
    // 只查「壳」这一个分区，不查 caches.match() 的全部。
    // 录音分区里有 6 千多个条目，一次全局查找要把它们也过一遍 ——
    // 每个脚本、每张图都付这个成本，手机上就是整页慢半拍。
    shellCache()
      // ignoreSearch：页面引用脚本时会带 ?v=0.17.0 这类版本串，而预缓存里存的是不带串的地址。
      // 不忽略 query 的话，带串的请求永远命中不了缓存 —— 断网时整页脚本都拿不到。
      // 静态资源不需要按 query 区分版本，VERSION 已经区分了。
      .then((c) => c.match(req, { ignoreSearch: true }))
      .then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            shellCache().then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
  );
});
