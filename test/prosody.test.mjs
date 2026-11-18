import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../prosody.js");

/* ================= 断句：气口 ================= */

test("按句号断开：一句话里两个句子 = 两口气，第一口留 300ms", () => {
  const segs = P.splitClauses("Good morning. What can I get for you today?");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, "Good morning.");
  assert.equal(segs[1].text, "What can I get for you today?");
  assert.equal(segs[0].pause, 300);
  assert.equal(segs[1].pause, 0, "最后一段不留白，收尾交给播放层");
});

test("逗号也断，但停顿更短 —— 逗号 170ms，比句号短一截", () => {
  const segs = P.splitClauses("I'd like a medium coffee, with a little milk.");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pause, 170);
  assert.ok(P.PAUSE.comma < P.PAUSE.end);
});

test("一两个词的碎片并到后一段，避免「Yes,」单独念成一截", () => {
  const segs = P.splitClauses("Yes, do you have any sandwiches left?");
  assert.equal(segs.length, 1, "Yes 并进后一段");
  assert.ok(segs[0].text.startsWith("Yes,"));
  P.splitClauses("A, B, C, and then we left the room.").forEach((s) => {
    assert.ok(s.text.split(/\s+/).filter(Boolean).length > 1, "不能出现单词片段：" + s.text);
  });
});

test("小数点和缩写点不切句", () => {
  assert.equal(P.splitClauses("It costs 5.30 dollars.").length, 1);
  assert.equal(P.splitClauses("Mr. Smith is waiting outside.").length, 1);
});

/* ================= 语气：谁在说、什么情绪 ================= */

test("两个人声线不同：B 比 A 低，也略慢", () => {
  const a = P.planLine("Is it far from here?", { speaker: "A" });
  const b = P.planLine("Is it far from here?", { speaker: "B" });
  assert.equal(a.speaker, "A");
  assert.equal(b.speaker, "B");
  assert.ok(b.segments[0].pitch < a.segments[0].pitch, "B 的声音应该更低");
  assert.ok(b.segments[0].rate < a.segments[0].rate, "B 的语速应该略慢");
});

test("问句尾音上翘，陈述句尾音下沉", () => {
  const q = P.planLine("Is it far from here?", { speaker: "A" }).segments.slice(-1)[0];
  const s = P.planLine("It takes about five minutes.", { speaker: "A" }).segments.slice(-1)[0];
  assert.ok(q.pitch > s.pitch, `问句 ${q.pitch} 应高于陈述句 ${s.pitch}`);
});

test("话没说完的片段尾音略抬，让句子连着往下走", () => {
  const segs = P.planLine("I'd like a medium coffee, with a little milk.", { speaker: "A" }).segments;
  assert.ok(segs.length >= 2);
  assert.ok(segs[0].pitch > segs[1].pitch, "前半句应该比收尾高一点");
});

test("语速不再是一条直线：同一句里各段有轻微差异", () => {
  const segs = P.planLine("Sure, go straight down this road, and turn left at the bank.", { speaker: "A" }).segments;
  const rates = segs.map((s) => s.rate);
  assert.ok(new Set(rates).size > 1, "每段语速一模一样就是机械感的来源：" + rates.join(","));
  rates.forEach((r) => assert.ok(r >= 0.6 && r <= 1.6));
});

test("好消息和坏消息念得不一样：情绪只做微小偏移，不搞朗诵腔", () => {
  const good = P.planLine("That sounds great, I'd love to come.", { speaker: "B" });
  const bad = P.planLine("I'm sorry, the room is closed and the bus is late.", { speaker: "B" });
  assert.equal(good.emotion.warm > 0, true);
  assert.equal(bad.emotion.tense > 0, true);
  const g = good.segments[0].pitch, b = bad.segments[0].pitch;
  assert.ok(Math.abs(g - b) < 0.12, `偏移必须很小，否则就成了念稿：${g} vs ${b}`);
});

test("慢速是整句等比放慢，不是把某一段单独拉长", () => {
  const normal = P.planLine("This is the museum we visited last year.", { speaker: "A", speed: 1 });
  const slow = P.planLine("This is the museum we visited last year.", { speaker: "A", speed: 0.8 });
  normal.segments.forEach((s, i) => {
    assert.ok(Math.abs(slow.segments[i].rate - s.rate * 0.8) < 0.001);
  });
});

/* ================= 同音词 ================= */

test("音标写法的差异不影响「听起来一样」的判断", () => {
  assert.equal(P.soundKey("ˈsiː"), P.soundKey("si"));
  assert.equal(P.soundKey("/piːs/"), P.soundKey("piːs"));
  assert.equal(P.soundKey("siː"), P.soundKey("si"));
  assert.notEqual(P.soundKey("siː"), P.soundKey("sɪ"));
  assert.equal(P.soundKey(""), "");
});

/* ================= 选音色 ================= */

test("音色排序：神经网络 > 大厂 > 普通本地 > 低质引擎", () => {
  const natural = P.scoreVoice({ name: "Microsoft Aria Online (Natural)", lang: "en-US" });
  const google = P.scoreVoice({ name: "Google US English", lang: "en-US" });
  const plain = P.scoreVoice({ name: "English (America)", lang: "en-US" });
  const bad = P.scoreVoice({ name: "English (America) compact", lang: "en-US" });
  assert.ok(natural > google, `${natural} 应大于 ${google}`);
  assert.ok(google > plain);
  assert.ok(plain > bad, "compact 这类低质引擎要排到最后");
});

test("中文音色一律不选", () => {
  assert.equal(P.scoreVoice({ name: "Microsoft Huihui", lang: "zh-CN" }), -1);
  assert.equal(P.scoreVoice(null), -1);
});

test("挑两个音色给 A / B：优先最好的，但必须不是同一个", () => {
  const list = [
    { name: "Vendor Voice", lang: "en-US" },
    { name: "Microsoft Aria Online (Natural)", lang: "en-US" },
    { name: "Google US English", lang: "en-US" }
  ];
  const pick = P.pickVoices(list, "");
  assert.equal(pick.a.name, "Microsoft Aria Online (Natural)", "最好的给 A");
  assert.equal(pick.b.name, "Google US English");
  assert.equal(pick.distinct, true);
});

test("用户手动选过就听用户的；只有一个音色时复用同一个（靠音高分开）", () => {
  const many = [{ name: "A Voice", lang: "en-US" }, { name: "B Voice", lang: "en-GB" }];
  assert.equal(P.pickVoices(many, "B Voice").a.name, "B Voice");

  const one = [{ name: "Only Voice", lang: "en-US" }];
  const pick = P.pickVoices(one, "");
  assert.equal(pick.a.name, "Only Voice");
  assert.equal(pick.b.name, "Only Voice");
  assert.equal(pick.distinct, false);
});
