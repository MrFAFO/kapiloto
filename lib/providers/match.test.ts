import assert from "node:assert/strict";
import test from "node:test";

import {
  bestHybridAliasSimilarity,
  crossScriptTeamSimilarity,
  romanizeTeamName,
} from "./match";

test("romanizes common Hebrew club names into provider spellings", () => {
  assert.equal(romanizeTeamName("מכבי חיפה"), "maccabi haifa");
  assert.equal(romanizeTeamName("ניוקאסל"), "newcastle");
  assert.equal(romanizeTeamName("בולוניה"), "bologna");
});

test("cross-script matching covers current Winner 16 European clubs", () => {
  const pairs: Array<[string, string]> = [
    ["קובנטרי", "Coventry City"],
    ["פולהאם", "Fulham"],
    ["האל", "Hull City"],
    ["ברנטפורד", "Brentford"],
    ["קריסטל פאלאס", "Crystal Palace"],
    ["ניוקאסל", "Newcastle United"],
    ["סנדרלנד", "Sunderland"],
    ["לידס", "Leeds United"],
    ["ראסינג סנטאנדר", "Racing Santander"],
    ["אספניול", "Espanyol"],
    ["ולנסיה", "Valencia"],
    ["ויאריאל", "Villarreal"],
    ["סלטה ויגו", "Celta Vigo"],
    ["בטיס", "Real Betis"],
    ["קליארי", "Cagliari"],
    ["בולוניה", "Bologna"],
    ["נאפולי", "Napoli"],
    ["רומא", "AS Roma"],
    ["פ.צ. קלן", "1. FC Köln"],
    ["שאלקה 04", "FC Schalke 04"],
    ["פאדרבורן", "SC Paderborn 07"],
    ["המבורג", "Hamburger SV"],
  ];

  for (const [canonical, provider] of pairs) {
    assert.ok(
      crossScriptTeamSimilarity(canonical, provider) >= 0.6,
      `${canonical} should match ${provider}`,
    );
  }
});

test("hybrid matching keeps exact aliases while adding cross-script support", () => {
  assert.equal(
    bestHybridAliasSimilarity("Maccabi Haifa", "מכבי חיפה", ["מכבי חיפה"]),
    1,
  );
  assert.ok(
    bestHybridAliasSimilarity("Hull City", "האל", ["האל סיטי"]) >= 0.6,
  );
});
