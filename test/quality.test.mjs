import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));

const PAGES = ["index.html", "game.html", "words.html", "listening.html"];

/* 这一组测的是「壳」的质量：可访问性、SEO 基础、离线清单自洽。
   它们出错时页面还能跑，所以肉眼永远发现不了 —— 只能靠断言守住。 */

test("每个页面都有跳过导航、主地标和唯一的 h1", () => {
  for (const f of PAGES) {
    const src = read(f);
    assert.match(src, /class="vq-skip"\s+href="#main"/, f + " 缺少跳到主要内容的链接");
    assert.match(src, /<main[^>]*id="main"/, f + " 缺少 main 地标");
    const h1 = src.match(/<h1[\s>]/g) || [];
    assert.equal(h1.length, 1, f + " 应当只有一个 h1，实际 " + h1.length);
  }
});

test("每个页面都引用公共样式 ui.css，且它被离线清单收录", () => {
  for (const f of PAGES) {
    assert.match(read(f), /<link rel="stylesheet" href="\.\/ui\.css\?v=[\d.]+">/, f + " 未引用 ui.css");
  }
  assert.match(read("sw.js"), /"\.\/ui\.css"/, "sw.js 预缓存里没有 ui.css，断网时会掉样式");
});

test("html lang / title / description 都在，且标题不重复", () => {
  const titles = new Set();
  for (const f of PAGES) {
    const src = read(f);
    assert.match(src, /<html lang="zh-CN">/, f + " 缺少 lang");
    const title = (src.match(/<title>([^<]+)<\/title>/) || [])[1];
    assert.ok(title && title.trim().length >= 4, f + " 标题为空或过短");
    titles.add(title);
    const desc = (src.match(/<meta name="description" content="([^"]*)"/) || [])[1];
    assert.ok(desc && desc.length >= 20, f + " 描述为空或过短");
    assert.ok(desc.length <= 160, f + " 描述超过 160 字，搜索结果里会被截断");
    assert.match(src, /<meta name="viewport" content="[^"]*width=device-width/, f + " 缺少视口声明");
  }
  assert.equal(titles.size, PAGES.length, "四个页面的 title 应各不相同");
});

test("答题反馈对读屏可见：feedback 是 live region，进度条有 role", () => {
  const src = read("game.html");
  assert.match(src, /id="feedback"[^>]*aria-live="polite"/, "答对答错必须能被读出来");
  assert.match(src, /id="progTrack"[^>]*role="progressbar"/, "本关进度条缺少 progressbar 角色");
  assert.match(src, /id="placeTrack"[^>]*role="progressbar"/, "定级进度条缺少 progressbar 角色");
  assert.match(src, /id="toast"[^>]*aria-live="polite"/, "toast 提示对读屏不可见");
  assert.match(read("listening.html"), /id="progTrack"[^>]*role="progressbar"/, "听写进度条缺少 progressbar 角色");
});

test("图标按钮都有可访问名", () => {
  for (const f of PAGES) {
    const src = read(f);
    // 「只有箭头/符号」的按钮，必须靠 aria-label 说出它干什么
    const bare = [...src.matchAll(/<button\b([^>]*)>([^<]{0,3})<\/button>/g)];
    for (const m of bare) {
      const [, attrs, text] = m;
      if (/aria-label=|aria-labelledby=/.test(attrs)) continue;
      assert.ok(text.trim().length > 0, f + " 有按钮既没有文字也没有 aria-label");
    }
  }
});

test("词库页不再静态挂四套词库，改成按分类只加载一套", () => {
  const src = read("words.html");
  const staticTags = [...src.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(!staticTags.some((s) => /^vocab/.test(s)),
    "页面上还有静态词库 <script>：首屏会多下几百 KB 根本用不到的词：\n" + staticTags.join("\n"));
  assert.match(src, /s\.src=CFG\.file/, "缺少按分类动态加载词库的代码");
  assert.match(src, /(?:const|let|var) CATS\s*=\s*\{/, "缺少分类 → 词库文件 的映射表");
  for (const f of ["vocab_cz.js", "vocab.js", "vocab_c6.js", "vocab_gz.js"]) {
    assert.ok(src.includes(f), "映射表里少了 " + f);
  }
});

test("离线清单里每个文件都真实存在", () => {
  const src = read("sw.js");
  const list = (src.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || "";
  const files = [...list.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
  assert.ok(files.length > 10, "离线清单看起来没解析出来");
  for (const f of files) {
    assert.ok(exists(f), "sw.js 预缓存了不存在的文件：" + f);
  }
});

test("sitemap 与 robots 指向真实页面，域名一致", () => {
  assert.ok(exists("robots.txt"), "缺少 robots.txt");
  assert.ok(exists("sitemap.xml"), "缺少 sitemap.xml");
  assert.ok(exists("404.html"), "缺少 404.html");

  const sm = read("sitemap.xml");
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 3, "sitemap 里页面太少");
  for (const url of locs) {
    const rel = url.replace(/^https:\/\/zbqt\.github\.io\/vocab-quest\//, "");
    const file = rel === "" ? "index.html" : rel;
    assert.ok(exists(file), "sitemap 指向了不存在的文件：" + url);
  }
  assert.match(read("robots.txt"), /Sitemap: https:\/\/zbqt\.github\.io\/vocab-quest\/sitemap\.xml/,
    "robots.txt 的 sitemap 地址要与站点域名一致");
  for (const f of ["index.html", "game.html", "words.html", "listening.html"]) {
    const canonical = (read(f).match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    assert.ok(canonical, f + " 缺少 canonical");
    assert.match(canonical, /^https:\/\/zbqt\.github\.io\/vocab-quest\//, f + " canonical 域名不对：" + canonical);
  }
});

test("结构化数据是合法 JSON，且说明了这是什么应用", () => {
  const src = read("index.html");
  const blocks = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1, "首页没有结构化数据");
  const data = JSON.parse(blocks[0][1]);
  const graph = data["@graph"] || [data];
  const app = graph.find((x) => x["@type"] === "WebApplication");
  const faq = graph.find((x) => x["@type"] === "FAQPage");
  assert.ok(app, "缺少 WebApplication 声明");
  assert.equal(app.offers.price, "0", "免费应用应写明 price=0");
  assert.ok(faq && faq.mainEntity.length >= 3, "FAQ 条目太少");
  // FAQ 的可见文本必须与结构化数据对得上，否则搜索引擎会判作弊
  const strip = (s) => String(s).replace(/[「」]/g, "");
  const pageText = strip(src);
  for (const q of faq.mainEntity) {
    assert.ok(pageText.includes(strip(q.name)), "结构化数据里的问题在页面上找不到：" + q.name);
  }
});

test("manifest 的快捷入口都指向真实页面", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.lang, "zh-CN");
  assert.ok(m.start_url, "缺少 start_url");
  for (const s of m.shortcuts || []) {
    const file = String(s.url).split("?")[0].replace(/^\.\//, "");
    assert.ok(exists(file), "快捷入口指向不存在的文件：" + s.url);
  }
  for (const icon of m.icons) {
    assert.ok(exists(icon.src.replace(/^\.\//, "")), "图标不存在：" + icon.src);
  }
});

test("页面引用的本地脚本都在离线预缓存清单里（漏一个就是断网白屏）", () => {
  const sw = read("sw.js");
  const block = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [, ""])[1];
  assert.ok(block.length > 100, "没解析到 ASSETS");
  const cached = new Set([...block.matchAll(/"\.\/([^"?]+)"/g)].map((m) => m[1]));

  const missing = [];
  for (const f of ["game.html", "words.html", "index.html", "listening.html"]) {
    const src = read(f);
    for (const m of src.matchAll(/<(?:script|link)[^>]*?(?:src|href)\s*=\s*"([^"]+)"/g)) {
      const u = m[1].split("?")[0].replace(/^\.\//, "");
      // 只看本地实在文件：外链、锚点、以及页面之间的跳转链接不在预缓存范围内
      if (/^(https?:)?\/\//.test(u) || u.startsWith("#") || u.endsWith(".html")) continue;
      if (!cached.has(u)) missing.push(f + " → " + u);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "这些资源离线拿不到：\n" + missing.join("\n"));
});
