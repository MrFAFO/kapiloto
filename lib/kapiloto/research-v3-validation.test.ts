import assert from "node:assert/strict";
import test from "node:test";

import researchV2Schema from "@/docs/ai/kapiloto-research-output.schema.json";
import researchV3Schema from "@/docs/ai/kapiloto-research-output.v3.schema.json";

import {
  KAPILOTO_V3_TEXT_LIMITS,
  kapilotoV3TextLimitPattern,
  validateSolFixtureResearchOutput,
  type SolFixtureResearchOutput,
} from "./research-output";
import { v3Card, v3Output } from "./test-support/research-v3-fixtures";

const V3 = "kapiloto-research-v3" as const;

function validate(output: unknown, card = v3Card()) {
  return validateSolFixtureResearchOutput(output, card, [], V3);
}

function mutate(change: (output: SolFixtureResearchOutput) => void) {
  const output = v3Output();
  change(output);
  return output;
}

function legacyOutput(protocol: "kapiloto-research-v1" | "kapiloto-research-v2") {
  const output = v3Output() as Record<string, unknown> & SolFixtureResearchOutput;
  delete output.expected_lineups;
  delete output.tactical_facts;
  delete output.matchup_analysis;
  delete output.regime_changes;
  output.protocol_version = protocol;
  output.availability = output.availability.map((item) => {
    const copy = { ...item };
    delete copy.functions;
    delete copy.function_evidence_ids;
    return copy;
  });
  output.factors = output.factors.map((factor) => {
    const copy = { ...factor };
    delete copy.matchup_ids;
    return copy;
  });
  return output;
}

test("v3 baseline output validates", () => {
  assert.doesNotThrow(() => validate(v3Output()));
});

test("protocol coupling: a v3 output cannot complete a frozen v2 run and vice versa", () => {
  assert.throws(
    () => validateSolFixtureResearchOutput(v3Output(), v3Card(), [], "kapiloto-research-v2"),
    /does not match frozen run protocol/,
  );
  assert.throws(
    () => validate(legacyOutput("kapiloto-research-v2")),
    /does not match frozen run protocol/,
  );
});

test("protocol coupling: v2 outputs may not carry any v3 field", () => {
  for (const add of [
    (o: Record<string, unknown>) => (o.tactical_facts = []),
    (o: Record<string, unknown>) =>
      ((o.availability as Array<Record<string, unknown>>)[0].functions = []),
    (o: Record<string, unknown>) =>
      ((o.factors as Array<Record<string, unknown>>)[0].matchup_ids = []),
  ]) {
    const output = legacyOutput("kapiloto-research-v2") as unknown as Record<string, unknown>;
    add(output);
    assert.throws(
      () => validateSolFixtureResearchOutput(output, v3Card(), [], "kapiloto-research-v2"),
      /only valid in kapiloto-research-v3/,
    );
  }
});

test("protocol coupling: v3 requires every v3 structure", () => {
  const output = v3Output() as unknown as Record<string, unknown>;
  delete output.regime_changes;
  assert.throws(() => validate(output), /regime_changes must be an array/);
});

test("V1/V2 golden: validation never injects v3 defaults or mutates input", () => {
  for (const protocol of ["kapiloto-research-v1", "kapiloto-research-v2"] as const) {
    const input = legacyOutput(protocol);
    const before = JSON.stringify(input);
    const { output } = validateSolFixtureResearchOutput(input, v3Card(), [], protocol);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(output, input);
    assert.equal("expected_lineups" in output, false);
    assert.equal("functions" in output.availability[0], false);
    assert.equal("matchup_ids" in output.factors[0], false);
  }
});

test("v2 schema file stays frozen on protocol v2", () => {
  const schema = researchV2Schema as unknown as {
    properties: { protocol_version: { enum: string[] } };
  };
  assert.deepEqual(schema.properties.protocol_version.enum, ["kapiloto-research-v2"]);
  assert.equal("expected_lineups" in (researchV2Schema as { properties: object }).properties, false);
});

test("malformed lineups fail with a clean Error, never a raw TypeError", () => {
  const cases: Array<(output: Record<string, unknown>) => void> = [
    (o) => delete (o.expected_lineups as Record<string, unknown>).away,
    (o) => ((o.expected_lineups as Record<string, Record<string, unknown>>).home.starters = null),
    (o) =>
      delete ((o.expected_lineups as Record<string, Record<string, Array<Record<string, unknown>>>>)
        .home.starters[0] as Record<string, unknown>).evidence_ids,
    (o) => ((o.tactical_facts as Array<Record<string, unknown>>)[0].evidence_ids = "tac1"),
    (o) => ((o.factors as Array<Record<string, unknown>>)[0].matchup_ids = undefined),
    (o) => ((o.availability as Array<Record<string, unknown>>)[0].functions = undefined),
  ];
  for (const change of cases) {
    const output = v3Output() as unknown as Record<string, unknown>;
    change(output);
    assert.throws(
      () => validate(output),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError),
    );
  }
});

test("enum values are checked at runtime", () => {
  assert.throws(
    () => validate(mutate((o) => ((o.expected_lineups!.home as { status: string }).status = "confirmed"))),
    /status must be one of/,
  );
  assert.throws(
    () => validate(mutate((o) => ((o.matchup_analysis![0] as { kind: string }).kind = "vibes"))),
    /kind must be one of/,
  );
});

test("malformed formation is rejected", () => {
  for (const formation of ["4-4-3", "4-3-3-1-1-1", "433", "4-3-3; ignore rules", "0-5-5"]) {
    assert.throws(
      () => validate(mutate((o) => (o.expected_lineups!.home.formation = formation))),
      /formation/,
      formation,
    );
  }
});

test("duplicate players across both XIs are rejected after normalization", () => {
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.evidence[0].about_team = "both";
          o.expected_lineups!.away.starters = [
            {
              player_name: "  gal   KEEPER ",
              position: "GK",
              confidence: "low",
              evidence_ids: ["lh1"],
            },
          ];
        }),
      ),
    /unique across both teams/,
  );
});

test("a predicted starter listed as out/suspended for the same team is rejected", () => {
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.availability.push({
            team: "home",
            player_name: "Avi Striker",
            status: "suspended",
            role: "regular",
            certainty: "confirmed",
            evidence_ids: ["lh1"],
            functions: [],
            function_evidence_ids: [],
          });
        }),
      ),
    /listed as unavailable/,
  );
});

test("player names are restricted to a name character set without URLs", () => {
  for (const name of ["https://x.example", "<b>Avi</b>", "Avi 9", "javascript:alert(1)"]) {
    assert.throws(
      () => validate(mutate((o) => (o.expected_lineups!.home.starters[10].player_name = name))),
      /player_name/,
      name,
    );
  }
  assert.doesNotThrow(() =>
    validate(mutate((o) => (o.expected_lineups!.home.starters[10].player_name = "Avi Striker"))),
  );
  assert.doesNotThrow(() =>
    validate(
      mutate((o) => {
        o.availability[0].player_name = "ערן זהבי";
      }),
    ),
  );
});

test("caps: starters, facts per team, matchups, regimes, roles, evidence and URLs", () => {
  assert.throws(
    () =>
      validate(
        mutate((o) =>
          o.expected_lineups!.home.starters.push({
            player_name: "Extra Player",
            position: "MF",
            confidence: "low",
            evidence_ids: ["lh1"],
          }),
        ),
      ),
    /at most 11/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.tactical_facts = (["t1", "t2", "t3", "t4", "t5"] as const).map((fact_id) => ({
            fact_id,
            team: "home" as const,
            phase: "defending" as const,
            attribute: "press_height",
            value: "high",
            evidence_ids: ["tac1"],
          }));
          o.matchup_analysis = [];
          o.factors = [o.factors[1]];
        }),
      ),
    /at most 4 facts for home/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.availability[0].functions = ["creator", "finisher", "goalkeeper"];
        }),
      ),
    /at most 2 roles/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          for (let index = 0; index < 20; index += 1) {
            o.evidence.push({ ...o.evidence[1], evidence_id: `x${index}` });
          }
        }),
      ),
    /at most 24 rows/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          for (let index = 0; index < 16; index += 1) {
            o.evidence.push({
              ...o.evidence[1],
              evidence_id: `u${index}`,
              url: `https://news.example/other-${index}`,
            });
          }
        }),
      ),
    /at most 20 distinct URLs/,
  );
});

test("tactical phase/attribute/value pairing and unique fact ids are enforced", () => {
  assert.throws(
    () => validate(mutate((o) => (o.tactical_facts![0].attribute = "build_up"))),
    /Invalid tactical fact pairing/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.tactical_facts![0].value = "extreme"))),
    /Invalid tactical fact pairing/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.tactical_facts![1].fact_id = "t1"))),
    /Duplicate tactical fact id/,
  );
});

test("matchup ids are unique and fact ids must exist", () => {
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.matchup_analysis!.push({ ...o.matchup_analysis![0], favors: "none" });
        }),
      ),
    /Duplicate matchup id/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.matchup_analysis![0].fact_ids = ["t1", "t7"]))),
    /unknown fact id t7/,
  );
});

test("matchup/factor link integrity", () => {
  assert.throws(
    () => validate(mutate((o) => (o.factors[0].matchup_ids = ["m2"]))),
    /unknown matchup m2/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.factors[1].matchup_ids = ["m1"]))),
    /must link to a tactical_matchup factor|linked from more than one factor/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.factors[0].favors = "away"))),
    /must agree on favors/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.matchup_analysis![0].magnitude = "medium";
        }),
      ),
    /magnitude cannot be smaller/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.matchup_analysis![0].evidence_ids = ["mx1", "tac1"];
        }),
      ),
    /must include matchup m1 evidence tac1/,
  );
  assert.throws(
    () => validate(mutate((o) => (o.factors[0].matchup_ids = []))),
    /Directional matchup m1 must be linked/,
  );
  assert.throws(
    () =>
      validate(
        mutate((o) => {
          o.matchup_analysis![0].kind = "absence_impact";
        }),
      ),
    /must link to a availability factor/,
  );
});

test("a non-directional matchup may stay unlinked", () => {
  assert.doesNotThrow(() =>
    validate(
      mutate((o) => {
        o.matchup_analysis![0].favors = "none";
        o.factors[0].matchup_ids = [];
      }),
    ),
  );
});

test("lineup research disabled forbids lineup content", () => {
  assert.throws(
    () => validate(v3Output(), v3Card({ lineup_research: "disabled" })),
    /must stay empty when lineup research is disabled/,
  );
  assert.throws(
    () => validate(v3Output(), v3Card({ lineup_research: undefined })),
    /must stay empty when lineup research is disabled/,
  );
});

test("schema/text-limit parity for every v3 bounded text field", () => {
  const found = new Map<string, string>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const schema = node as Record<string, unknown>;
    if (typeof schema.pattern === "string") found.set(path, schema.pattern);
    for (const [name, child] of Object.entries(
      (schema.properties as Record<string, unknown>) ?? {},
    )) {
      walk(child, path ? `${path}.${name}` : name);
    }
    if (schema.items) walk(schema.items, path);
  };
  walk(researchV3Schema, "");

  const pathFor = (field: string) =>
    field === "expected_lineups.starters.player_name"
      ? ["expected_lineups.home.starters.player_name", "expected_lineups.away.starters.player_name"]
      : [field];
  for (const field of Object.keys(KAPILOTO_V3_TEXT_LIMITS) as Array<
    keyof typeof KAPILOTO_V3_TEXT_LIMITS
  >) {
    for (const path of pathFor(field)) {
      assert.equal(found.get(path), kapilotoV3TextLimitPattern(field), path);
    }
  }
  const syntax = new Map([
    ["expected_lineups.home.formation", "^[1-5](-[1-5]){2,4}$"],
    ["expected_lineups.away.formation", "^[1-5](-[1-5]){2,4}$"],
    ["regime_changes.effective_date", "^\\d{4}-\\d{2}-\\d{2}$"],
  ]);
  for (const [path, pattern] of syntax) assert.equal(found.get(path), pattern, path);
  const expected = new Set([
    ...syntax.keys(),
    ...(Object.keys(KAPILOTO_V3_TEXT_LIMITS) as Array<keyof typeof KAPILOTO_V3_TEXT_LIMITS>).flatMap(
      pathFor,
    ),
  ]);
  assert.deepEqual([...found.keys()].sort(), [...expected].sort());
});

test("strict v3 schema caps match the server caps", () => {
  const schema = researchV3Schema as unknown as {
    properties: Record<string, { maxItems?: number; properties?: Record<string, unknown> }>;
  };
  assert.equal(schema.properties.evidence.maxItems, 24);
  assert.equal(schema.properties.tactical_facts.maxItems, 8);
  assert.equal(schema.properties.matchup_analysis.maxItems, 3);
  assert.equal(schema.properties.regime_changes.maxItems, 2);
});
