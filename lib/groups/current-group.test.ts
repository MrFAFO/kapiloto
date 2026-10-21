import assert from "node:assert/strict";
import test from "node:test";

import {
  selectActiveGroup,
  type ActiveGroupContext,
} from "./current-group";

const groups: ActiveGroupContext[] = [
  {
    groupId: "11111111-1111-4111-8111-111111111111",
    name: "First",
    defaultMaxDoubles: 7,
    role: "owner",
  },
  {
    groupId: "22222222-2222-4222-8222-222222222222",
    name: "Second",
    defaultMaxDoubles: 5,
    role: "member",
  },
];

test("selects explicitly requested active group", () => {
  assert.equal(
    selectActiveGroup(groups, "22222222-2222-4222-8222-222222222222")?.name,
    "Second",
  );
});

test("falls back to first membership when requested group is unavailable", () => {
  assert.equal(
    selectActiveGroup(groups, "33333333-3333-4333-8333-333333333333")?.name,
    "First",
  );
});

test("returns null when user has no active groups", () => {
  assert.equal(selectActiveGroup([], null), null);
});
