import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../dictation.js");

test("归一化：大小写、标点、撇号、连字符都不该影响判分", () => {
  assert.deepEqual(D.normalizeWords("Good morning, Sir!"), ["good", "morning", "sir"]);
  assert.deepEqual(D.normalizeWords("I don't know."), ["i", "dont", "know"]);
  assert.deepEqual(D.normalizeWords("a check-in desk"), ["a", "check", "in", "desk"]);
});

test("数字与数词互认：听到 two，写 2 也算对", () => {
  assert.deepEqual(D.normalizeWords("two bedrooms"), ["2", "bedrooms"]);
  assert.deepEqual(D.normalizeWords("2 bedrooms"), ["2", "bedrooms"]);
  const r = D.check("two bedrooms", "2 bedrooms");
  assert.equal(r.perfect, true);
});

test("完全听对：只差标点和大小写也算全对", () => {
  const r = D.check("I'd like a medium coffee, please.", "i'd like a medium coffee please");
  assert.equal(r.perfect, true);
  assert.equal(r.rate, 1);
  assert.equal(r.miss, 0);
  assert.equal(r.extra, 0);
});

test("漏一个词：只标那一个，后面的词不该跟着全错", () => {
  const r = D.check("Go straight down this road and turn left", "go straight down this road turn left");
  assert.equal(r.perfect, false);
  assert.equal(r.miss, 1);
  assert.equal(r.extra, 0);
  assert.equal(r.correct, 7, "7 个词听对，只有 and 漏了");
  const miss = r.tokens.filter((t) => t.miss).map((t) => t.w);
  assert.deepEqual(miss, ["and"]);
});

test("多写一个词：记进 extra，但不把后面的词判错", () => {
  const r = D.check("it takes about five minutes", "it takes about maybe five minutes");
  assert.equal(r.extra, 1);
  assert.equal(r.miss, 0);
  assert.equal(r.correct, 5);
  assert.equal(r.perfect, false, "多写的词也算听错");
  assert.deepEqual(r.tokens.filter((t) => t.extra).map((t) => t.w), ["maybe"]);
});

test("听错一个词：错的位置标成漏，正确的照常算对", () => {
  const r = D.check("The rent is eight hundred a month", "the rent is eight hundreds a month");
  assert.equal(r.correct, 6);
  assert.equal(r.miss, 1);
  assert.equal(r.extra, 1);
  assert.ok(r.rate > 0.7);
});

test("顺序错乱：按最长公共子序列对齐，不是逐位硬比", () => {
  const r = D.check("open the door", "door the open");
  // 逐位比会判 0 个对；LCS 至少能认出中间那个 the
  assert.equal(r.correct, 1);
  assert.equal(r.total, 3);
  assert.ok(r.tokens.some((t) => t.ok), "顺序反了也要认出至少一个词");
  assert.equal(r.perfect, false);
});

test("空输入：全漏、不算全对、不除以零", () => {
  const r = D.check("hello world", "");
  assert.equal(r.empty, true);
  assert.equal(r.correct, 0);
  assert.equal(r.miss, 2);
  assert.equal(r.rate, 0);
  assert.equal(r.perfect, false);
  const r2 = D.check("", "");
  assert.equal(r2.rate, 0, "空答案不能除出 NaN");
});

test("整段汇总：按词数加权，不是按句平均", () => {
  const a = D.check("one two three four five six seven eight nine ten", "one two three four five six seven eight nine ten");  // 10 词全对
  const b = D.check("short", "wrong");                                                                                      // 1 词全错
  const s = D.summary([a, b]);
  assert.equal(s.total, 11);
  assert.equal(s.correct, 10);
  assert.equal(s.perfect, 1);
  assert.equal(Math.round(s.rate * 100), 91, "按句平均会得到 50%，按词加权才是真实水平");
});
