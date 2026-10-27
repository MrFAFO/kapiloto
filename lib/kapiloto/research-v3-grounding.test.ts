import assert from "node:assert/strict";
import test from "node:test";

import type { SolFixtureResearchOutput } from "./research-output";
import { itemTrustTier, resolveV3TierMap } from "./research-v3-rules";
import { verifyGroundedResearchEvidence } from "./source-grounding";
import {
  groundV3,
  V3_EVIDENCE,
  v3Card,
  v3Documents,
  v3Output,
  v3Registry,
} from "./test-support/research-v3-fixtures";

function withEvidence(
  id: string,
  change: Partial<(typeof V3_EVIDENCE)[number]>,
): {
  output: SolFixtureResearchOutput;
  documents: ReturnType<typeof v3Documents>;
} {
  const specs = V3_EVIDENCE.map((spec) => (spec.id === id ? { ...spec, ...change } : spec));
  const output = v3Output();
  output.evidence = output.evidence.map((row) => {
    const spec = specs.find((item) => item.id === row.evidence_id)!;
    return {
      ...row,
      quote: spec.quote,
      claim: spec.quote.slice(0, 150),
      claim_type: spec.claimType,
      about_team: spec.aboutTeam,
      url: spec.url,
    };
  });
  return { output, documents: v3Documents(specs) };
}

const requestIds = (grounding: ReturnType<typeof groundV3>) =>
  (grounding.itemEntailmentRequests ?? []).map((item) => item.verificationId);

test("baseline v3 grounding creates server-written item requests for every v3 object", () => {
  const grounding = groundV3();
  assert.deepEqual(grounding.rejected, []);
  const ids = requestIds(grounding);
  for (let index = 0; index < 11; index += 1) {
    assert.ok(ids.includes(`lineup:home:starter:${index}`));
  }
  for (const id of [
    "lineup:home:formation",
    "availability:functions:0:defensive_anchor",
    "tactical_fact:t1",
    "tactical_fact:t2",
    "matchup:m1",
  ]) {
    assert.ok(ids.includes(id), id);
  }
  const claims = new Map(
    (grounding.itemEntailmentRequests ?? []).map((item) => [item.verificationId, item.claim]),
  );
  assert.equal(claims.get("lineup:home:starter:0"), "Gal Keeper is expected to start for Home FC.");
  assert.equal(claims.get("lineup:home:formation"), "Home FC is expected to use the 4-3-3 formation.");
  assert.equal(
    claims.get("availability:functions:0:defensive_anchor"),
    "Zed Anchor functions as defensive anchor for Away FC.",
  );
  assert.equal(claims.get("tactical_fact:t1"), "Home FC's defending press height is high.");
});

test("starter whose name is absent from the quote gets no entailment request", () => {
  const output = v3Output();
  output.expected_lineups!.home.starters[10].player_name = "Someone Else";
  const grounding = groundV3(output);
  assert.equal(requestIds(grounding).includes("lineup:home:starter:10"), false);
  assert.ok(grounding.policyFailures?.some((item) => /starter:10 quote does not name the player/.test(item)));
  assert.ok(requestIds(grounding).includes("lineup:home:starter:9"));
});

test("wrong about_team blocks the lineup item", () => {
  const { output, documents } = withEvidence("lh1", { aboutTeam: "away" });
  const grounding = groundV3(output, v3Card(), documents);
  assert.equal(requestIds(grounding).some((id) => id.startsWith("lineup:home")), false);
  assert.ok(grounding.policyFailures?.some((item) => /about_team_incompatible/.test(item)));
});

test("an item-incompatible claim type cannot be laundered into lineup or factor support", () => {
  const { output, documents } = withEvidence("lh1", { claimType: "other" });
  const grounding = groundV3(output, v3Card(), documents);
  assert.equal(requestIds(grounding).some((id) => id.startsWith("lineup:home")), false);
  assert.ok(grounding.policyFailures?.some((item) => /claim_type_incompatible:other/.test(item)));

  const relabelled = withEvidence("mx1", { claimType: "availability" });
  const factorGrounding = groundV3(relabelled.output, v3Card(), relabelled.documents);
  assert.deepEqual(factorGrounding.itemEvidenceExclusions?.["factor:0"], ["mx1"]);
});

test("undated lineup evidence is rejected for lineup use regardless of claim type", () => {
  const specs = V3_EVIDENCE.map((spec) =>
    spec.id === "lh1" ? { ...spec, publishedAt: null, claimType: "availability" } : spec,
  );
  const output = v3Output();
  output.evidence[0].claim_type = "availability";
  const grounding = groundV3(output, v3Card(), v3Documents(specs));
  assert.deepEqual(grounding.rejected, [
    { evidenceId: "lh1", reason: "undated_time_sensitive_claim" },
  ]);
  assert.equal(requestIds(grounding).some((id) => id.startsWith("lineup:home")), false);

  // Even a non-time-sensitive declared type cannot escape dating for lineups.
  const lenient = V3_EVIDENCE.map((spec) =>
    spec.id === "lh1" ? { ...spec, publishedAt: null } : spec,
  );
  const lineupOutput = v3Output();
  lineupOutput.evidence[0].claim_type = "lineup";
  const strict = groundV3(lineupOutput, v3Card(), v3Documents(lenient));
  assert.equal(requestIds(strict).some((id) => id.startsWith("lineup:home")), false);
});

test("lineup evidence older than 7 days, or before the latest match, is not usable", () => {
  const stale = withEvidence("lh1", { publishedAt: "2026-10-21T09:00:00.000Z" });
  const staleGrounding = groundV3(stale.output, v3Card(), stale.documents);
  assert.equal(requestIds(staleGrounding).some((id) => id.startsWith("lineup:home")), false);
  assert.ok(staleGrounding.policyFailures?.some((item) => /lh1=stale/.test(item)));

  const beforeMatch = withEvidence("lh1", { publishedAt: "2026-10-25T10:00:00.000Z" });
  const matchGrounding = groundV3(beforeMatch.output, v3Card(), beforeMatch.documents);
  assert.ok(matchGrounding.policyFailures?.some((item) => /lh1=before_last_match/.test(item)));
});

test("tactical evidence older than 45 days is not usable for a tactical fact", () => {
  const { output, documents } = withEvidence("tac1", { publishedAt: "2026-09-01T00:00:00.000Z" });
  const grounding = groundV3(output, v3Card(), documents);
  assert.equal(requestIds(grounding).includes("tactical_fact:t1"), false);
  assert.ok(grounding.policyFailures?.some((item) => /tactical_fact:t1 failed item provenance: tac1=stale/.test(item)));
});

test("a directional matchup needs its own evidence from the last 14 days", () => {
  const { output, documents } = withEvidence("mx1", { publishedAt: "2026-10-10T00:00:00.000Z" });
  const grounding = groundV3(output, v3Card(), documents);
  assert.equal(requestIds(grounding).includes("matchup:m1"), false);
  assert.ok(grounding.policyFailures?.some((item) => /matchup:m1 has no matchup evidence from the last 14 days/.test(item)));

  const neutral = withEvidence("mx1", { publishedAt: "2026-10-10T00:00:00.000Z" });
  neutral.output.matchup_analysis![0].favors = "none";
  const neutralGrounding = groundV3(neutral.output, v3Card(), neutral.documents);
  assert.ok(requestIds(neutralGrounding).includes("matchup:m1"));
});

test("post-cutoff evidence is rejected", () => {
  const { output, documents } = withEvidence("lh1", { publishedAt: "2026-10-29T13:00:00.000Z" });
  const grounding = groundV3(output, v3Card(), documents);
  assert.deepEqual(grounding.rejected, [{ evidenceId: "lh1", reason: "published_after_cutoff" }]);
});

test("evidence beyond 20 distinct URLs is rejected", () => {
  const output = v3Output();
  const specs = [...V3_EVIDENCE];
  for (let index = 0; index < 16; index += 1) {
    const spec = {
      ...V3_EVIDENCE[1],
      id: `extra-${index}`,
      url: `https://news.example/extra-${index}`,
    };
    specs.push(spec);
    output.evidence.push({ ...output.evidence[1], evidence_id: spec.id, url: spec.url });
  }
  const grounding = verifyGroundedResearchEvidence(
    output,
    v3Card(),
    v3Documents(specs),
    v3Registry(),
  );
  assert.deepEqual(
    grounding.rejected.map((item) => item.reason),
    ["url_cap_exceeded", "url_cap_exceeded"],
  );
});

test("regime change needs a real, in-window effective date", () => {
  const output = v3Output();
  output.evidence.push({
    evidence_id: "rg1",
    url: "https://news.example/away-coach",
    quote: "Away FC appointed a new head coach on 2026-10-27.",
    claim: "Away FC changed coach on 2026-10-27.",
    claim_type: "coach_regime",
    about_team: "away",
    event_time: null,
  });
  const specs = [
    ...V3_EVIDENCE,
    {
      id: "rg1",
      url: "https://news.example/away-coach",
      quote: "Away FC appointed a new head coach on 2026-10-27.",
      claimType: "coach_regime",
      aboutTeam: "away" as const,
      publishedAt: "2026-10-27T12:00:00.000Z",
    },
  ];
  for (const [date, ok] of [
    ["2026-10-27", true],
    ["2026-02-30", false],
    ["2026-11-02", false],
    ["2025-01-01", false],
  ] as const) {
    output.regime_changes = [
      { team: "away", type: "coach_change", effective_date: date, evidence_ids: ["rg1"] },
    ];
    const grounding = groundV3(output, v3Card(), v3Documents(specs));
    assert.equal(requestIds(grounding).includes("regime:0"), ok, date);
  }
  const claims = groundV3(
    { ...output, regime_changes: [{ team: "away", type: "coach_change", effective_date: "2026-10-27", evidence_ids: ["rg1"] }] },
    v3Card(),
    v3Documents(specs),
  ).itemEntailmentRequests?.find((item) => item.verificationId === "regime:0");
  assert.equal(claims?.claim, "Away FC changed head coach on 2026-10-27.");
});

test("source tier fallback for new claim types and anti-laundering item tiers", () => {
  const map = resolveV3TierMap({ availability: 1, tactical: 3, club_coach_news: 2, default: 3 });
  assert.equal(map.lineup, 1);
  assert.equal(map.formation, 3);
  assert.equal(map.tactical_setup, 3);
  assert.equal(map.coach_regime, 2);
  assert.equal(resolveV3TierMap({}).lineup, 4);

  // A tactical claim relabelled as "lineup" on an official club site cannot
  // borrow the lineup tier for a tactical item.
  const evidence = { trustTier: 1, claimTierMap: map };
  assert.equal(itemTrustTier(evidence, "tactical_setup"), 3);
  assert.equal(itemTrustTier(evidence, "lineup"), 1);

  const grounding = groundV3();
  const lineup = grounding.accepted.find((item) => item.modelEvidenceId === "lh1");
  assert.equal(lineup?.trustTier, 1);
  assert.equal(lineup?.claimTierMap?.lineup, 1);
});

test("web form claims cannot back a baseline_form factor when structured form exists", () => {
  const output = v3Output();
  output.evidence.push({
    evidence_id: "form1",
    url: "https://news.example/form",
    quote: "Home FC have won four in a row.",
    claim: "Home FC are in strong form.",
    claim_type: "form",
    about_team: "home",
    event_time: null,
  });
  output.factors.push({
    dimension: "baseline_form",
    favors: "home",
    magnitude: "small",
    evidence_ids: ["form1"],
    structured_refs: [],
    matchup_ids: [],
    rationale: "Recent form.",
  });
  const specs = [
    ...V3_EVIDENCE,
    {
      id: "form1",
      url: "https://news.example/form",
      quote: "Home FC have won four in a row.",
      claimType: "form",
      aboutTeam: "home" as const,
      publishedAt: "2026-10-28T00:00:00.000Z",
    },
  ];
  const grounding = groundV3(output, v3Card(), v3Documents(specs));
  assert.deepEqual(grounding.itemEvidenceExclusions?.["factor:2"], ["form1"]);
  assert.equal(grounding.requiresEntailmentVerification.includes("form1"), false);
});

test("v2 grounding output keeps its legacy shape", () => {
  const output = v3Output() as unknown as Record<string, unknown>;
  output.protocol_version = "kapiloto-research-v2";
  const grounding = verifyGroundedResearchEvidence(
    output as unknown as SolFixtureResearchOutput,
    v3Card(),
    v3Documents(),
    v3Registry(),
  );
  assert.equal("itemEntailmentRequests" in grounding, false);
  assert.equal("claimTierMap" in grounding.accepted[0], false);
});
