import assert from "node:assert/strict";
import test from "node:test";

import { chooseCurrentRound } from "./current-round";

test("prefers an open round over other lifecycle states", () => {
  const rows = [
    {
      id: "finished",
      external_round_number: "1",
      starts_at: null,
      lock_at: "2026-10-19T10:00:00Z",
      status: "finished",
    },
    {
      id: "open",
      external_round_number: "2",
      starts_at: null,
      lock_at: "2026-10-22T10:00:00Z",
      status: "open",
    },
    {
      id: "upcoming",
      external_round_number: "3",
      starts_at: null,
      lock_at: "2026-10-21T10:00:00Z",
      status: "upcoming",
    },
  ];

  assert.equal(
    chooseCurrentRound(rows, Date.parse("2026-10-20T10:00:00Z"))?.id,
    "open",
  );
});

test("within the same status prefers the nearest future lock", () => {
  const rows = [
    {
      id: "later",
      external_round_number: "2",
      starts_at: null,
      lock_at: "2026-10-25T10:00:00Z",
      status: "upcoming",
    },
    {
      id: "next",
      external_round_number: "3",
      starts_at: null,
      lock_at: "2026-10-21T10:00:00Z",
      status: "upcoming",
    },
  ];

  assert.equal(
    chooseCurrentRound(rows, Date.parse("2026-10-20T10:00:00Z"))?.id,
    "next",
  );
});

test("within past rounds prefers the most recently locked one", () => {
  const rows = [
    {
      id: "older",
      external_round_number: "1",
      starts_at: null,
      lock_at: "2026-10-10T10:00:00Z",
      status: "finished",
    },
    {
      id: "newer",
      external_round_number: "2",
      starts_at: null,
      lock_at: "2026-10-19T10:00:00Z",
      status: "finished",
    },
  ];

  assert.equal(
    chooseCurrentRound(rows, Date.parse("2026-10-20T10:00:00Z"))?.id,
    "newer",
  );
});

test("returns null when no rounds exist", () => {
  assert.equal(chooseCurrentRound([], Date.now()), null);
});
