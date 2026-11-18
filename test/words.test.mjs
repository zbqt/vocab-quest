import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { stripTail } from "../tools/fix-zh-names.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

const HTML = read("words.html");
const INLINE = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join("\n");
const DATA_FILES = ["vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js"];
const FILE_BY_CAT = { cz: "vocab_cz.js", gz: "vocab_gz.js", cet4: "vocab.js", c6: "vocab_c6.js" };

function catOf(search) {
  const c = (new URLSearchParams(search).get("cat") || "cet4").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FILE_BY_CAT, c) ? c : "cet4";
}

/* 只把「当前那一套词库」注入宿主 —— 和真实浏览器一样。
   页面要是偷偷又去引用别套词库的全局量，这里会直接报错。 */
function load(search, expand) {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/words.html" + search,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.speechSynthesis = { cancel() {}, speak() {} };
  win.SpeechSynthesisUtterance = class {};
  win.eval(read(FILE_BY_CAT[catOf(search)]) + "\n" + INLINE);
  const doc = win.document;
  if (expand) expandAll(win, doc);
  return { win, doc };
}
/* 单元是懒渲染的：只有展开时才往 DOM 里塞词行 */
function expandAll(win, doc) {
  doc.querySelectorAll("details.unit").forEach((d) => {
    d.open = true;
    d.dispatchEvent(new win.Event("toggle"));
  });
}
const rows = (doc) => doc.querySelectorAll(".w-row").length;

test("words.html 不带 cat 参数也能正常渲染（回归：get('cat') 为 null 时 .toLowerCase() 崩溃）", () => {
  const { win, doc } = load("");
  assert.equal(doc.getElementById("pageTitle").textContent, "英语四级", "缺参数应回退到四级");
  const units = doc.getElementById("units");
  assert.ok(units.querySelectorAll("details.unit").length > 10, "单元卡片应渲染出来");
  assert.ok(rows(doc) > 0, "第一个单元应默认展开并渲染");
  assert.ok(rows(doc) < 500, "首屏不该把 3737 行一次性塞进 DOM");
  expandAll(win, doc);
  assert.equal(rows(doc), 3737, "展开全部单元后应能看到整本词库");
});

test("words.html cat 为空值或非法值都回退四级", () => {
  for (const q of ["?cat=", "?cat=unknown", "?cat=%20"]) {
    const { win, doc } = load(q, true);
    assert.equal(doc.getElementById("pageTitle").textContent, "英语四级", q + " 应回退四级");
    assert.ok(rows(doc) > 1000, q + " 应渲染词库");
  }
});

test("words.html 按 cat 参数切换词书，标题与词数一致", () => {
  const cases = [
    ["?cat=gz", "高中英语", 3663],
    ["?cat=cz", "初中英语", 1417],
    ["?cat=c6", "英语六级", 2078],
    ["?cat=CET4", "英语四级", 3737],
  ];
  for (const [q, name, total] of cases) {
    const { win, doc } = load(q, true);
    assert.equal(doc.getElementById("pageTitle").textContent, name, q + " 标题不对");
    assert.equal(rows(doc), total, q + " 展开后词行数应与词库一致");
    const sub = doc.getElementById("pageSub").textContent;
    assert.match(sub, /共 [\d,]+ 词/, q + " 副标题词数缺失：" + sub);
  }
});

test("词库页搜索：未展开的单元也能搜到，命中高亮，清空能还原", async () => {
  const { win, doc } = load("");
  const input = doc.getElementById("search");
  const fire = () => input.dispatchEvent(new win.Event("input"));
  const settle = () => new Promise((r) => setTimeout(r, 220));

  input.value = "abandon";
  fire();
  await settle();
  const hits = rows(doc);
  assert.ok(hits > 0 && hits < 100, "应只显示命中的词，实际 " + hits);
  assert.ok(doc.querySelectorAll("mark").length > 0, "命中片段应高亮");
  assert.match(doc.getElementById("resultTip").textContent, /找到/, "应给出结果数");

  // 搜一个跨单元的中文词，验证没展开过的单元也会被搜出来
  input.value = "能力";
  fire();
  await settle();
  assert.ok(rows(doc) > 0, "中文释义也应能搜到");
  assert.ok([...doc.querySelectorAll("details.unit")].some((d) => d.open), "命中单元应自动展开");

  doc.getElementById("clearBtn").click();
  await settle();
  assert.ok(rows(doc) > 0 && rows(doc) < 500, "清空后应回到只渲染第一个单元的状态");
  assert.equal(input.value, "", "清空按钮应清掉输入框");
});

// ── 释义数据质量：词典导出的「人名音译」段必须清干净（A1）──────────────
// 这段东西长这样：`able → adj. 有能力的；n. (Able)人名；(伊朗)阿布勒；(英)埃布尔`
// 对背单词零价值，还会把英译中选项撑长，一眼就能排除法排掉。
const VOCAB = DATA_FILES.map((f) => {
  const src = read(f);
  const name = (src.match(/const\s+(\w+)\s*=/) || [])[1];
  const groups = new Function(src + `;return ${name};`)();
  return { file: f, words: groups.flatMap((g) => g.words) };
});

test("释义里没有人名音译段：n. (Able)人名；(伊朗)阿布勒 这种尾巴一个都不留", () => {
  const bad = [];
  for (const { file, words } of VOCAB) {
    for (const [en, zh] of words) {
      // 标准段 (Xxx)人名…、变体 （法）埃尔（人名）、以及「；X（人名，…）」
      if (/\([A-Za-z][A-Za-z .]*\)人名/.test(zh) || /（人名/.test(zh) || /人名[；)]?\s*$/.test(zh)) {
        bad.push(`${file}:${en} | ${zh}`);
      }
    }
  }
  assert.equal(bad.length, 0, "还有 " + bad.length + " 条带着人名音译：\n" + bad.slice(0, 5).join("\n"));
});

test("释义没有乱码：U+FFFD 和落错区的拉丁字符都不许出现", () => {
  // 故意不看「候选人名单」「以他人名义」这种正常中文，只看字符本身
  const MOJI = /[\uFFFD\u00A0-\u00FF]/;
  const bad = [];
  for (const { file, words } of VOCAB) {
    for (const [en, zh] of words) {
      if (MOJI.test(zh)) bad.push(`${file}:${en} | ${zh}`);
    }
  }
  assert.equal(bad.length, 0, "还有 " + bad.length + " 条乱码：\n" + bad.slice(0, 5).join("\n"));
});

test("清理脚本只删人名段、不误伤正常中文，也不把释义删空", () => {
  const cases = [
    ["adj. 能；[经管] 有能力的；能干的；n. (Able)人名；(伊朗)阿布勒；(英)埃布尔", "adj. 能；[经管] 有能力的；能干的"],
    ["pron. 他（宾格）；n. (Him)人名；(东南亚国家华语)欣；(柬)亨；(中)谦(广东话·威妥玛)", "pron. 他（宾格）"],
    ["pron. 她（she的宾格）；她的（she的所有格）；n. （法）埃尔（人名）", "pron. 她（she的宾格）；她的（she的所有格）"],
    ["n. 六月；琼（人名，来源于拉丁语，含义是“年轻气盛的六月”）", "n. 六月"],
    // 「人名」二字只是恰好连着出现，不是词典的人名段，必须原样保留
    ["n. 票；入场券；（美）候选人名单；v. 加标签于", "n. 票；入场券；（美）候选人名单；v. 加标签于"],
    ["n. 仓库；v. 以他人名义购进（股票）", "n. 仓库；v. 以他人名义购进（股票）"],
    ["n. (Only)人名；(英)奥恩利", "n. (Only)人名；(英)奥恩利"], // 删完就空了，宁可留着
  ];
  for (const [input, want] of cases) assert.equal(stripTail(input).zh, want, "输入：" + input);
});

test("清理脚本是幂等的：洗过的词库再跑一遍不会有任何改动", () => {
  for (const { file, words } of VOCAB) {
    for (const [en, zh] of words) {
      assert.equal(stripTail(zh).hit, false, `${file}:${en} 还能再洗一次，说明没洗干净 | ${zh}`);
    }
  }
});
