import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUsername,
  parseRecoveryIdentifier,
  passwordValidationError,
  safeNextPath,
  usernameValidationError,
} from "./identity";

test("normalizes usernames without changing Hebrew characters", () => {
  assert.equal(normalizeUsername("  Ofek_93  "), "ofek_93");
  assert.equal(normalizeUsername("  אופק93  "), "אופק93");
});

test("validates username shape and password length", () => {
  assert.equal(usernameValidationError("ofek.93"), null);
  assert.equal(usernameValidationError("אופק-93"), null);
  assert.equal(usernameValidationError("a b"), "username_characters");
  assert.equal(usernameValidationError("ab"), "username_length");
  assert.equal(passwordValidationError("12345678"), null);
  assert.equal(passwordValidationError("1234567"), "password_length");
});

test("normalizes email and Israeli mobile recovery identifiers", () => {
  assert.deepEqual(parseRecoveryIdentifier(" User@Example.COM "), {
    type: "email",
    value: "user@example.com",
  });
  assert.deepEqual(parseRecoveryIdentifier("050-1234567"), {
    type: "phone",
    value: "+972501234567",
  });
  assert.deepEqual(parseRecoveryIdentifier("+1 415 555 0123"), {
    type: "phone",
    value: "+14155550123",
  });
  assert.equal(parseRecoveryIdentifier("not-an-identifier"), null);
});

test("safeNextPath rejects external redirects", () => {
  assert.equal(safeNextPath("/reset-password"), "/reset-password");
  assert.equal(safeNextPath("https://example.com"), "/");
  assert.equal(safeNextPath("//example.com"), "/");
});
