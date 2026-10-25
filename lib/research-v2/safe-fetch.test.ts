import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { FETCHER_CONFIG, isBlockedAddress, pinnedRequestOptions, safeFetch, type Resolver, type Transport, type TransportResponse } from "./safe-fetch";

const PUBLIC = "93.184.216.34";
const publicResolver: Resolver = async () => [{ address: PUBLIC, family: 4 }];

async function* chunks(...parts: Array<string | Buffer>): AsyncIterable<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}

function response(status: number, headers: Record<string, string>, ...body: Array<string | Buffer>): TransportResponse {
  return { status, headers, body: chunks(...body), destroy: () => {} };
}

/** A transport that answers from a script keyed by URL and records every call. */
function scripted(routes: Record<string, () => TransportResponse>, calls: Array<{ url: string; address: string; headers: Record<string, string> }> = []): Transport {
  return async ({ url, address, headers }) => {
    calls.push({ url: url.toString(), address, headers });
    const route = routes[url.toString()];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
}

const html = (body: string) => response(200, { "content-type": "text/html; charset=utf-8" }, `<html><body>${body}</body></html>`);

test("private, loopback, link-local, CGNAT, multicast, reserved and mapped addresses are blocked; public ones are not", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip",
  ]) assert.equal(isBlockedAddress(address), true, address);
  for (const address of [PUBLIC, "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("URL policy: only http/https on 80/443, no credentials, no IP literals or local hostnames, no transport call", async () => {
  const calls: string[] = [];
  const resolver: Resolver = async (host) => {
    calls.push(host);
    return [{ address: PUBLIC, family: 4 }];
  };
  const transport: Transport = async () => {
    throw new Error("must not connect");
  };
  const cases: Array<[string, string]> = [
    ["ftp://news.example.com/a", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["https://user:pass@news.example.com/a", "credentials_in_url"],
    ["http://127.0.0.1/admin", "ip_literal_host"],
    ["http://[::1]/admin", "ip_literal_host"],
    ["http://169.254.169.254/latest/meta-data", "ip_literal_host"],
    ["http://localhost/a", "blocked_hostname"],
    ["http://api.localhost/a", "blocked_hostname"],
    ["http://printer.local/a", "blocked_hostname"],
    ["http://intranet/a", "blocked_hostname"],
    ["https://news.example.com:8443/a", "port_not_allowed"],
    ["not a url", "invalid_url"],
  ];
  for (const [url, reason] of cases) {
    const result = await safeFetch(url, { resolver, transport });
    assert.equal(result.ok, false, url);
    assert.equal(!result.ok && result.reason, reason, url);
    assert.equal(result.decisions[0]?.allowed, false, url);
  }
  assert.deepEqual(calls, [], "no DNS lookup for a URL that fails policy");
});

test("DNS is checked before connecting; any blocked address in the answer refuses the host", async () => {
  const transport: Transport = async () => {
    throw new Error("must not connect");
  };
  const privateOnly = await safeFetch("https://evil.example.com/", { resolver: async () => [{ address: "10.0.0.5", family: 4 }], transport });
  assert.equal(!privateOnly.ok && privateOnly.reason, "resolves_to_blocked_address");
  const mixed = await safeFetch("https://evil.example.com/", {
    resolver: async () => [{ address: PUBLIC, family: 4 }, { address: "::1", family: 6 }],
    transport,
  });
  assert.equal(!mixed.ok && mixed.reason, "resolves_to_blocked_address");
  const empty = await safeFetch("https://evil.example.com/", { resolver: async () => [], transport });
  assert.equal(!empty.ok && empty.reason, "no_addresses");
  const failing = await safeFetch("https://evil.example.com/", { resolver: async () => { throw new Error("ENOTFOUND"); }, transport });
  assert.equal(!failing.ok && failing.reason, "dns_failure");
});

test("the connection is pinned to the validated address (no rebinding) and DNS is resolved once per hop", async () => {
  let lookups = 0;
  const rebinding: Resolver = async () => {
    lookups += 1;
    return lookups === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  };
  const calls: Array<{ url: string; address: string; headers: Record<string, string> }> = [];
  const result = await safeFetch("https://news.example.com/a", { resolver: rebinding, transport: scripted({ "https://news.example.com/a": () => html("ok") }, calls) });
  assert.equal(result.ok, true);
  assert.equal(lookups, 1);
  assert.equal(calls[0].address, PUBLIC);

  const options = pinnedRequestOptions(new URL("https://news.example.com/a?b=1"), PUBLIC, 4, {});
  assert.equal(options.hostname, "news.example.com");
  assert.equal(options.servername, "news.example.com", "SNI and certificate checks use the hostname");
  assert.equal(options.path, "/a?b=1");
  assert.equal(options.agent, false);
  const resolved: unknown[] = [];
  (options.lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)("news.example.com", {}, (...args) => resolved.push(...args));
  assert.deepEqual(resolved, [null, PUBLIC, 4]);
  const all: unknown[] = [];
  (options.lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)("news.example.com", { all: true }, (...args) => all.push(...args));
  assert.deepEqual(all, [null, [{ address: PUBLIC, family: 4 }]]);
});

test("no cookies, credentials or referrer are sent; only a fixed user agent", async () => {
  const calls: Array<{ url: string; address: string; headers: Record<string, string> }> = [];
  await safeFetch("https://news.example.com/a", { resolver: publicResolver, transport: scripted({ "https://news.example.com/a": () => html("ok") }, calls) });
  const sent = Object.keys(calls[0].headers).map((key) => key.toLowerCase());
  assert.deepEqual(sent.sort(), ["accept", "accept-encoding", "user-agent"]);
  assert.equal(calls[0].headers["user-agent"], FETCHER_CONFIG.userAgent);
});

test("redirects are followed manually, each target revalidated, at most three", async () => {
  const ok = await safeFetch("http://news.example.com/a", {
    resolver: publicResolver,
    transport: scripted({
      "http://news.example.com/a": () => response(301, { location: "https://news.example.com/a" }),
      "https://news.example.com/a": () => response(302, { location: "/b?x=1#frag" }),
      "https://news.example.com/b?x=1": () => html("final"),
    }),
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.finalUrl, "https://news.example.com/b?x=1");
    assert.equal(ok.redirects.length, 2);
    assert.equal(ok.decisions.length, 3);
  }

  const toPrivate = await safeFetch("https://news.example.com/a", {
    resolver: async (host) => (host === "internal.example.com" ? [{ address: "192.168.0.10", family: 4 }] : [{ address: PUBLIC, family: 4 }]),
    transport: scripted({ "https://news.example.com/a": () => response(302, { location: "https://internal.example.com/secret" }) }),
  });
  assert.equal(!toPrivate.ok && toPrivate.reason, "resolves_to_blocked_address");
  const toLiteral = await safeFetch("https://news.example.com/a", {
    resolver: publicResolver,
    transport: scripted({ "https://news.example.com/a": () => response(307, { location: "http://169.254.169.254/latest" }) }),
  });
  assert.equal(!toLiteral.ok && toLiteral.reason, "ip_literal_host");
  const toFile = await safeFetch("https://news.example.com/a", {
    resolver: publicResolver,
    transport: scripted({ "https://news.example.com/a": () => response(302, { location: "file:///etc/passwd" }) }),
  });
  assert.equal(!toFile.ok && toFile.reason, "unsupported_scheme");

  const loop: Record<string, () => TransportResponse> = {};
  for (let i = 0; i < 5; i += 1) loop[`https://news.example.com/${i}`] = () => response(302, { location: `/${i + 1}` });
  const tooMany = await safeFetch("https://news.example.com/0", { resolver: publicResolver, transport: scripted(loop) });
  assert.equal(!tooMany.ok && tooMany.reason, "too_many_redirects");
  assert.equal(tooMany.redirects.length, FETCHER_CONFIG.maxRedirects);
  const noLocation = await safeFetch("https://news.example.com/a", { resolver: publicResolver, transport: scripted({ "https://news.example.com/a": () => response(302, {}) }) });
  assert.equal(!noLocation.ok && noLocation.reason, "redirect_without_location");
});

test("only text content types are accepted, and non-2xx statuses fail", async () => {
  const fetchWith = (headers: Record<string, string>, status = 200) =>
    safeFetch("https://news.example.com/a", { resolver: publicResolver, transport: scripted({ "https://news.example.com/a": () => response(status, headers, "x") }) });
  assert.equal((await fetchWith({ "content-type": "text/plain" })).ok, true);
  assert.equal((await fetchWith({ "content-type": "application/xhtml+xml; charset=utf-8" })).ok, true);
  for (const type of ["application/pdf", "image/png", "application/json", "application/octet-stream"]) {
    const result = await fetchWith({ "content-type": type });
    assert.equal(!result.ok && result.reason, "unsupported_content_type", type);
  }
  const missing = await fetchWith({});
  assert.equal(!missing.ok && missing.reason, "missing_content_type");
  const notFound = await fetchWith({ "content-type": "text/html" }, 404);
  assert.equal(!notFound.ok && notFound.reason, "http_status");
});

test("the size limit applies to declared length, streamed bytes and decompressed bytes", async () => {
  const config = { ...FETCHER_CONFIG, maxBytes: 1_000 };
  const run = (route: () => TransportResponse) => safeFetch("https://news.example.com/a", { config, resolver: publicResolver, transport: scripted({ "https://news.example.com/a": route }) });
  const declared = await run(() => response(200, { "content-type": "text/html", "content-length": "5000" }, "x"));
  assert.equal(!declared.ok && declared.reason, "response_too_large");
  const streamed = await run(() => response(200, { "content-type": "text/html" }, "a".repeat(600), "b".repeat(600)));
  assert.equal(!streamed.ok && streamed.reason, "response_too_large");
  const bomb = await run(() => response(200, { "content-type": "text/html", "content-encoding": "gzip" }, zlib.gzipSync("z".repeat(50_000))));
  assert.equal(!bomb.ok && bomb.reason, "response_too_large");
  const gzipOk = await run(() => response(200, { "content-type": "text/html", "content-encoding": "gzip" }, zlib.gzipSync("<p>hello</p>")));
  assert.equal(gzipOk.ok && gzipOk.body, "<p>hello</p>");
  const unknown = await run(() => response(200, { "content-type": "text/html", "content-encoding": "zstd" }, "x"));
  assert.equal(!unknown.ok && unknown.reason, "unsupported_encoding");
});

test("a stalled response times out", async () => {
  const config = { ...FETCHER_CONFIG, timeoutMs: 50 };
  const stalled: Transport = async () => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) },
    destroy: () => {},
  });
  const result = await safeFetch("https://news.example.com/a", { config, resolver: publicResolver, transport: stalled });
  assert.equal(!result.ok && result.reason, "timeout");
  const slowDns = await safeFetch("https://news.example.com/a", { config, resolver: () => new Promise(() => {}), transport: stalled });
  assert.equal(!slowDns.ok && slowDns.reason, "timeout");
});

test("the declared charset is used for decoding, the body hash is recorded and the final URL is canonical", async () => {
  const hebrew = Buffer.from([0xf9, 0xec, 0xe5, 0xed]); // "שלום" in windows-1255
  const result = await safeFetch("https://news.example.com/a#section", {
    resolver: publicResolver,
    transport: scripted({ "https://news.example.com/a": () => response(200, { "content-type": "text/html; charset=windows-1255" }, hebrew) }),
    now: () => new Date("2026-10-25T10:00:00Z"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body, "שלום");
  assert.equal(result.charset, "windows-1255");
  assert.match(result.bodySha256, /^[0-9a-f]{64}$/);
  assert.equal(result.finalUrl, "https://news.example.com/a");
  assert.equal(result.retrievedAt, "2026-10-25T10:00:00.000Z");
});
