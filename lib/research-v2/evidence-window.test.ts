import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceWindow,
  checkEvidenceWindow,
  EVIDENCE_WINDOW_CONFIG,
  locateQuote,
  normalizeForMatch,
  sha256Text,
} from "./evidence-window";

const filler = (n: number, c = "x") => c.repeat(n);

test("normalization unifies quotes, dashes, case, width and whitespace", () => {
  assert.equal(normalizeForMatch("Smith’s  “late”\n— fitness  TEST"), `smith's "late" - fitness test`);
  assert.equal(normalizeForMatch("ＡＢＣ ﬁ"), "abc fi");
  assert.equal(normalizeForMatch("  leading and trailing  "), "leading and trailing");
});

test("a quote is located verbatim (after normalization) with offsets into the original text", () => {
  const text = "Team news.\nThe manager said Smith’s knee\n  injury will keep him out. More text.";
  const location = locateQuote(text, "Smith's knee injury will keep him out")!;
  assert.ok(location);
  assert.equal(text.slice(location.start, location.end), "Smith’s knee\n  injury will keep him out");
  assert.equal(location.occurrences, 1);
  assert.equal(locateQuote(text, "Jones is fit"), null);
  assert.equal(locateQuote(text, "   "), null);
  assert.equal(locateQuote("a b a b", "a b")!.occurrences, 2);
});

test("offsets stay correct around astral characters and Hebrew text", () => {
  const text = "⚽ Update 😀: הפועל באר שבע — השוער לא ישחק";
  const location = locateQuote(text, "השוער לא ישחק")!;
  assert.equal(text.slice(location.start, location.end), "השוער לא ישחק");
  const emoji = locateQuote(text, "update 😀")!;
  assert.equal(text.slice(emoji.start, emoji.end), "Update 😀");
});

test("the window is quote ± radius, capped at maxLength, with offsets and hashes", () => {
  const text = `${filler(1000, "a")}QUOTE TEXT HERE${filler(1000, "b")}`;
  const location = locateQuote(text, "quote text here")!;
  const window = buildEvidenceWindow(text, location);
  assert.equal(window.text.length, 400 + 15 + 400);
  assert.equal(window.text.slice(window.quoteStart, window.quoteEnd), "QUOTE TEXT HERE");
  assert.equal(window.windowStart, 600);
  assert.equal(window.windowEnd, 1415);
  assert.equal(window.windowSha256, sha256Text(window.text));
  assert.equal(window.documentTextSha256, sha256Text(text));
  assert.ok(window.text.length <= EVIDENCE_WINDOW_CONFIG.maxLength);
});

test("near the document edges the window gives the unused side to the other, still capped", () => {
  const text = `QUOTE${filler(2000, "b")}`;
  const window = buildEvidenceWindow(text, locateQuote(text, "quote")!, { ...EVIDENCE_WINDOW_CONFIG, radius: 2000, maxLength: 1200 });
  assert.equal(window.windowStart, 0);
  assert.equal(window.text.length, 1200);
  assert.equal(window.quoteStart, 0);
  const short = buildEvidenceWindow("abc QUOTE def", locateQuote("abc QUOTE def", "quote")!);
  assert.equal(short.text, "abc QUOTE def");
});

test("a window never splits a surrogate pair", () => {
  const text = `${"😀".repeat(300)}QUOTE${"😀".repeat(300)}`;
  const window = buildEvidenceWindow(text, locateQuote(text, "quote")!, { ...EVIDENCE_WINDOW_CONFIG, radius: 401 });
  assert.ok(!/^[\uDC00-\uDFFF]/.test(window.text) && !/[\uD800-\uDBFF]$/.test(window.text));
  assert.equal(window.text.slice(window.quoteStart, window.quoteEnd), "QUOTE");
});

test("replay checks work on the stored window alone: hash, quote at offsets, entity and support span", () => {
  const text = `${filler(50)} Coach: "Smith misses Saturday." Smith has a knee injury. ${filler(50)}`;
  const window = buildEvidenceWindow(text, locateQuote(text, "Smith misses Saturday.")!);
  const stored = JSON.parse(JSON.stringify(window));
  assert.deepEqual(checkEvidenceWindow(stored, { quote: "Smith misses Saturday.", entityName: "SMITH", supportSpan: "Smith has a knee injury" }), {
    hashMatches: true,
    quoteAtOffsets: true,
    entityInWindow: true,
    spanInWindow: true,
  });
  const tampered = { ...stored, text: stored.text.replace("knee", "ankle") };
  const check = checkEvidenceWindow(tampered, { quote: "Smith misses Saturday.", entityName: "Jones", supportSpan: "Smith has a knee injury" });
  assert.equal(check.hashMatches, false);
  assert.equal(check.entityInWindow, false);
  assert.equal(check.spanInWindow, false);
  assert.equal(checkEvidenceWindow(stored, { quote: "Different quote" }).quoteAtOffsets, false);
  assert.equal(checkEvidenceWindow(stored, { quote: "Smith misses Saturday." }).entityInWindow, null);
});

test("an invalid quote location is refused", () => {
  assert.throws(() => buildEvidenceWindow("abc", { start: 2, end: 1, occurrences: 1 }), /invalid quote location/);
  assert.throws(() => buildEvidenceWindow("abc", { start: 0, end: 9, occurrences: 1 }), /invalid quote location/);
});
