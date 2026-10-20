import assert from "node:assert/strict";
import test from "node:test";

import {
  __testOnly,
  isBlockedSourceAddress,
} from "./source-retriever";

test("source address guard blocks private, loopback and documentation ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.2.3.4",
    "172.16.1.2",
    "192.168.1.20",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.10",
    "198.51.100.4",
    "203.0.113.7",
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedSourceAddress(address), true, address);
  }

  assert.equal(isBlockedSourceAddress("8.8.8.8"), false);
  assert.equal(
    isBlockedSourceAddress("2606:4700:4700::1111"),
    false,
  );
});

test("source URL validation rejects credentials and non-standard ports", () => {
  assert.throws(
    () => __testOnly.validateSourceUrl("https://user:pass@example.com/a"),
    /credentials/,
  );
  assert.throws(
    () => __testOnly.validateSourceUrl("https://example.com:8443/a"),
    /non-standard port/,
  );
  assert.throws(
    () => __testOnly.validateSourceUrl("file:///etc/passwd"),
    /http or https/,
  );

  assert.equal(
    __testOnly.validateSourceUrl("https://example.com/report").hostname,
    "example.com",
  );
});

test("HTML source normalization strips executable markup and preserves quote text", () => {
  const html = `
    <html>
      <head>
        <style>.hidden { display:none }</style>
        <script>ignoreThis()</script>
      </head>
      <body>
        <article>
          <p>Coach said &quot;the player is ready&quot; for the match.</p>
        </article>
      </body>
    </html>
  `;

  const text = __testOnly.htmlToText(html);

  assert.equal(
    text,
    'Coach said "the player is ready" for the match.',
  );
  assert.ok(!text.includes("ignoreThis"));
  assert.ok(!text.includes("display:none"));
});

test("published-at parser recognizes common article metadata", () => {
  const html = `
    <html>
      <head>
        <meta property="article:published_time" content="2026-10-20T08:15:00Z">
      </head>
    </html>
  `;

  assert.equal(
    __testOnly.firstPublishedAt(html),
    "2026-10-20T08:15:00.000Z",
  );
});
