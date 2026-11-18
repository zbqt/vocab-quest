import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../sentence-audio.js", import.meta.url), "utf8");
const ctx = vm.createContext({});
vm.runInContext(src + ";globalThis.OUT=VQSentence;", ctx);
const S = ctx.OUT;

test("整句地址：默认美音，B 走英音那条声线", () => {
  assert.equal(S.accentOf("A"), "en");
  assert.equal(S.accentOf("B"), "uk");
  assert.equal(S.accentOf(undefined), "en", "没标说话人就按 A");

  const a = S.url("Good morning.", { accent: "en" });
  const b = S.url("Good morning.", { accent: "uk" });
  assert.ok(a.includes("lan=en"));
  assert.ok(b.includes("lan=uk"));
  assert.notEqual(a, b);
});

test("整句地址：空格、撇号、问号都要编码，否则地址会被截断", () => {
  const u = S.url("What's the time?", { accent: "en" });
  assert.ok(u.includes("text=What's%20the%20time%3F") || u.includes("text=What%27s%20the%20time%3F"),
    "实际地址：" + u);
  assert.ok(!/\s/.test(u), "地址里不能有裸空格");
  assert.ok(u.includes("source=web"));
});

test("清洗：破折号换成逗号，多余空格压掉，标点前不留空格", () => {
  assert.equal(S.clean("I  was — well,  late ."), "I was, well, late.");
  assert.equal(S.clean("  Hello   there  "), "Hello there");
  assert.equal(S.clean(null), "");
});

test("清洗不能改意思：数字、货币、撇号原样保留", () => {
  const s = S.clean("It's $10.50, isn't it?");
  assert.equal(s, "It's $10.50, isn't it?");
});

test("普通一句只取一段：拆开会让每段都念成句尾降调，比整句更机械", () => {
  const cues = S.cues("Good morning. What can I get for you today?", { speaker: "A" });
  assert.equal(cues.length, 1, "132 字符以内一律整句一次要");
  assert.equal(cues[0].gap, 0, "最后一段不留人工空白，收尾交给音频自己");
});

test("超长句按句子边界拆，拆完不丢词、不重词", () => {
  const sent = "The library closes at nine on weekdays. We do not take returns after that. "
    + "You had better come back tomorrow morning. ";
  const long = sent.repeat(4).trim();
  const cues = S.cues(long, { speaker: "A", maxChars: 120 });
  assert.ok(cues.length > 1, "超长必须拆，否则接口会截断");

  const joined = cues.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
  const want = S.clean(long);
  assert.equal(joined, want, "拆完拼回去必须和原文一致");
  cues.slice(0, -1).forEach((c) => assert.equal(c.gap, 140, "拆开的地方补一点气口"));
});

test("一句到底没有标点的长文本，在空格处硬切，不断词", () => {
  const long = ("alpha bravo charlie delta echo foxtrot golf hotel ").repeat(8).trim();
  const parts = S.splitLong(long, 100);
  assert.ok(parts.length > 1);
  parts.forEach((p) => assert.ok(p.length <= 100, "每段不超过上限：" + p.length));
  // 每个词都必须完整出现，不能被切成 "char" + "lie"
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

test("splitLong 对短句是恒等操作", () => {
  const s = "Where is the nearest bank?";
  const out = S.splitLong(s, 280);
  assert.equal(out.length, 1);
  assert.equal(out[0], s);
});

test("cues 给每段都带可直接喂给 <audio> 的地址", () => {
  const cues = S.cues("Excuse me, is this seat taken?", { speaker: "B" });
  assert.equal(cues.length, 1);
  assert.ok(cues[0].url.startsWith("https://"));
  assert.ok(cues[0].url.includes("lan=uk"), "B 的地址要带英音声线");
  assert.ok(cues[0].url.includes(encodeURIComponent(cues[0].text)));
});

test("空台词不产出任何片段", () => {
  assert.equal(S.cues("", {}).length, 0);
  assert.equal(S.cues("   ", {}).length, 0);
  assert.equal(S.cues(null, {}).length, 0);
});
