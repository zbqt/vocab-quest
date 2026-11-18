/* 中文释义判分：用户手写的汉语和词库释义算不算一个意思。
 *
 * 这一层最怕两件事：判太松（写错也算对，练了个寂寞）、判太严（听对了却判错，
 * 人会被判到怀疑耳朵）。所以用例分两边写：该过的必须过，该拦的必须拦。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Z = require("../zh-match.js");

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 词库是浏览器脚本（`const VOCAB = [...]`），不是 CommonJS 模块 ——
   直接 require 拿到的是空对象，所以按脚本求值一次再把变量取出来。 */
function loadBank(file) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  // 第一个 const 赋值号之后就是那段数组字面量（文件开头有行注释，不能用 ^ 去锚）
  const m = src.match(/const\s+[A-Z_0-9]+\s*=\s*/);
  if (!m) return [];
  const units = new Function("return " + src.slice(m.index + m[0].length))();
  if (!Array.isArray(units)) return [];
  // 词库是「单元数组」，每个单元里才是词：摊平成 [en, zh, ph]
  const flat = [];
  units.forEach((u) => {
    if (u && Array.isArray(u.words)) u.words.forEach((w) => flat.push(w));
  });
  return flat;
}

test("拆义项：剥掉词性、剥掉学科标记，一个义项内部的并列说法也拆开", () => {
  assert.deepEqual(Z.senses("n. 牺牲；牺牲品"), ["牺牲", "牺牲品"]);
  // [经管] 是词典的学科标签，不是释义的一部分
  assert.deepEqual(Z.senses("adj. 能；[经管] 有能力的；能干的"), ["能", "有能力的", "能干的"]);
  // 「和，与」是同一个义项的两种说法，都该能用
  assert.deepEqual(Z.senses("conj. 和，与；就"), ["和", "与", "就"]);
});

test("人名段整段丢掉，包括它后面那些「(伊朗)阿布勒」式的音译", () => {
  const list = Z.senses("conj. 和，与；n. (And)人名；(土、瑞典)安德");
  assert.ok(list.includes("和"));
  // 安德 是人名的音译，留着等于让用户靠一个地名答对
  assert.ok(!list.includes("安德"), "人名音译不能当义项：" + list.join(","));

  const able = Z.senses("n. (Able)人名；(伊朗)阿布勒；(英)埃布尔");
  assert.deepEqual(able, [], "整条都是人名时不该剩下任何义项：" + able.join(","));
});

test("写出其中一个义项就算对", () => {
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲").ok, true);
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲品").ok, true);
  assert.equal(Z.check("v. 出席；照顾，护理", "照顾").ok, true);
  assert.equal(Z.check("v. 出席；照顾，护理", "护理").ok, true);
});

test("写近义说法也算对：用户写的是释义的一部分，不该被判错", () => {
  assert.equal(Z.check("adj. 能；[经管] 有能力的；能干的", "能干").ok, true);
  assert.equal(Z.check("n. 周围的事物，环境", "环境").ok, true);
  assert.equal(Z.check("adj. 想不到的，意外的", "想不到").ok, true, "「想不到的」里包含「想不到」");
});

test("写错意思必须拦下来：宁可判错，也不能把对错搞混", () => {
  assert.equal(Z.check("n. 牺牲；牺牲品", "祭品").ok, false);
  assert.equal(Z.check("v. 出席；照顾，护理", "治疗").ok, false);
  assert.equal(Z.check("n. 不足，缺少，不足额", "短缺").ok, false, "意思接近但没写在释义里，不算对");
});

test("写英文不算对：听错了拼写写上来，不该蒙混过去", () => {
  assert.equal(Z.check("v. 出席；照顾，护理", "attend").ok, false);
  assert.equal(Z.check("n. 牺牲；牺牲品", "sacrifice").ok, false);
});

test("标点、空格、全角半角都不影响判分", () => {
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲 ").ok, true);
  assert.equal(Z.check("n. 牺牲；牺牲品", " 牺牲 ").ok, true);
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲。").ok, true);
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲，").ok, true);
});

test("一次写好几个义项也对：用户把「不足、缺少」连着写是常态", () => {
  assert.equal(Z.check("n. 不足，缺少，不足额", "不足、缺少").ok, true);
  assert.equal(Z.check("n. 不足，缺少，不足额", "不足；缺少").ok, true);
  assert.equal(Z.check("n. 不足，缺少，不足额", "缺少，不足").ok, true);
});

test("单字不乱匹配：长度门槛挡住「的」「不」这种碎片", () => {
  // 「的」出现在很多释义里，但它是虚词，不能靠它算对
  assert.equal(Z.check("adj. 能；有能力的；能干的", "的").ok, false);
  assert.equal(Z.check("n. 不足，缺少，不足额", "不").ok, false);
});

test("命中时回最贴切的那个义项，不是最长的那个", () => {
  // 用户写「牺牲」，反馈就该回「牺牲」，回「牺牲品」会让人以为自己的答案被改写了
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲").matched, "牺牲");
  assert.equal(Z.check("n. 牺牲；牺牲品", "牺牲品").matched, "牺牲品");
});

test("对真实词库自洽：每条释义的第一个义项，自己写出来必须判对", () => {
  const files = ["vocab.js", "vocab_c6.js", "vocab_cz.js", "vocab_gz.js"];
  let checked = 0, broken = [];

  files.forEach((f) => {
    loadBank(f).forEach((w) => {
      if (!Array.isArray(w) || typeof w[1] !== "string") return;
      const first = Z.senses(w[1])[0];
      if (!first) return;            // 纯人名 / 空释义，跳过
      checked++;
      if (!Z.check(w[1], first).ok) broken.push(w[0] + " | " + w[1] + " | 写「" + first + "」判错");
    });
  });

  assert.ok(checked > 3000, "真实词库应该有几万条释义，实际只测到 " + checked);
  assert.deepEqual(broken.slice(0, 5), [], "有 " + broken.length + " 条释义写对了第一个义项却判错");
});
