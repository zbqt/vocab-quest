import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

const HTML = read("words.html");
const INLINE = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join("\n");
const DATA_FILES = ["vocab_cz.js", "vocab_gz.js", "vocab.js", "vocab_c6.js"];

function load(search) {
  const dom = new JSDOM(HTML, {
    url: "http://localhost/words.html" + search,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // jsdom 没有语音合成，给个空壳；words.html 的发音只在点击时调用
  win.speechSynthesis = { cancel() {}, speak() {} };
  win.SpeechSynthesisUtterance = class {};
  // 必须一次性 eval：`const VOCAB_CZ` 这类顶层常量在多次 eval 之间不共享
  win.eval(DATA_FILES.map(read).join("\n") + "\n" + INLINE);
  return { win, doc: win.document };
}

test("words.html 不带 cat 参数也能正常渲染（回归：get('cat') 为 null 时 .toLowerCase() 崩溃）", () => {
  const { doc } = load("");
  assert.equal(doc.getElementById("pageTitle").textContent, "英语四级", "缺参数应回退到四级");
  const units = doc.getElementById("units");
  assert.ok(units.innerHTML.length > 1000, "词库应渲染出内容");
  assert.ok(units.querySelectorAll(".w-row").length > 1000, "应渲染出上千条单词行");
});

test("words.html cat 为空值或非法值都回退四级", () => {
  for (const q of ["?cat=", "?cat=unknown", "?cat=%20"]) {
    const { doc } = load(q);
    assert.equal(doc.getElementById("pageTitle").textContent, "英语四级", q + " 应回退四级");
    assert.ok(doc.getElementById("units").querySelectorAll(".w-row").length > 1000, q + " 应渲染词库");
  }
});

test("words.html 按 cat 参数切换词书，标题与词数一致", () => {
  const cases = [
    ["?cat=gz", "高中英语"],
    ["?cat=cz", "初中英语"],
    ["?cat=c6", "英语六级"],
    ["?cat=CET4", "英语四级"],
  ];
  for (const [q, name] of cases) {
    const { doc } = load(q);
    assert.equal(doc.getElementById("pageTitle").textContent, name, q + " 标题不对");
    const rows = doc.getElementById("units").querySelectorAll(".w-row").length;
    assert.ok(rows > 500, q + " 单词行过少：" + rows);
    const sub = doc.getElementById("pageSub").textContent;
    assert.match(sub, /共 \d{3,5} 词/, q + " 副标题词数缺失：" + sub);
  }
});
