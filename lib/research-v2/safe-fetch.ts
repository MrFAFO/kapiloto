import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";

import type { VersionedConfig } from "./provenance";

/**
 * SSRF-safe GET for evidence pages (fetcher-v1, D-047). Every hop is
 * validated: http/https on an allowed port, no credentials, no IP-literal or
 * local hostnames, DNS resolved before connecting with every address checked
 * against private, loopback, link-local, CGNAT, multicast and reserved ranges,
 * and the connection pinned to the validated address (no DNS rebinding).
 * Redirects are followed manually and revalidated; size, content type,
 * encoding and time are bounded; no cookies, credentials or referrer are sent.
 */

export type FetcherConfig = VersionedConfig & {
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
  allowedContentTypes: string[];
  allowedPorts: number[];
  userAgent: string;
};

export const FETCHER_CONFIG: FetcherConfig = {
  id: "research-v2-fetcher",
  version: "fetcher-v1",
  status: "candidate",
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
  allowedPorts: [80, 443],
  userAgent: "KapilotoResearchVerifier/1.0 (evidence verification; GET only)",
};

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
BLOCKED.addAddress("255.255.255.255", "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64], ["2001::", 23],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) IPv6 address. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED.check(address, "ipv4");
  const v4 = embeddedIpv4(address);
  if (v4) return BLOCKED.check(v4, "ipv4");
  return BLOCKED.check(address, "ipv6");
}

export type FetchFailure =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "ip_literal_host"
  | "blocked_hostname"
  | "port_not_allowed"
  | "dns_failure"
  | "no_addresses"
  | "resolves_to_blocked_address"
  | "timeout"
  | "too_many_redirects"
  | "redirect_without_location"
  | "http_status"
  | "missing_content_type"
  | "unsupported_content_type"
  | "unsupported_encoding"
  | "response_too_large"
  | "decompression_failed"
  | "transport_error";

export type FetchDecision = { url: string; host: string | null; addresses: string[]; allowed: boolean; reason: FetchFailure | null };

export type ResponseCheck = "passed" | "failed" | "not_reached";
/** Acceptance checks on the final (non-redirect) response, in the order they run. */
export type ResponseChecks = {
  httpStatus: number | null;
  status: ResponseCheck;
  mediaType: string | null;
  contentType: ResponseCheck;
  encoding: ResponseCheck;
  size: ResponseCheck;
  bytes: number | null;
};

const notReached = (): ResponseChecks => ({ httpStatus: null, status: "not_reached", mediaType: null, contentType: "not_reached", encoding: "not_reached", size: "not_reached", bytes: null });

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};
export type Transport = (request: { url: URL; address: string; family: 4 | 6; headers: Record<string, string> }) => Promise<TransportResponse>;

export type SafeFetchResult =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      status: number;
      contentType: string;
      charset: string;
      bytes: number;
      /** SHA-256 of the decoded body bytes. The text itself is transient and never persisted. */
      bodySha256: string;
      body: string;
      redirects: Array<{ from: string; to: string; status: number }>;
      decisions: FetchDecision[];
      responseChecks: ResponseChecks;
      retrievedAt: string;
    }
  | {
      ok: false;
      requestedUrl: string;
      reason: FetchFailure;
      detail: string | null;
      redirects: Array<{ from: string; to: string; status: number }>;
      decisions: FetchDecision[];
      responseChecks: ResponseChecks;
    };

const defaultResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));

/** Request options that pin the socket to the validated address while keeping the hostname for SNI and the Host header. */
export function pinnedRequestOptions(url: URL, address: string, family: 4 | 6, headers: Record<string, string>): https.RequestOptions {
  const lookup = ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as https.RequestOptions["lookup"];
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers,
    lookup,
    agent: false,
    ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
  };
}

const defaultTransport: Transport = ({ url, address, family, headers }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(pinnedRequestOptions(url, address, family, headers), (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: response,
        destroy: () => response.destroy(),
      });
    });
    request.on("error", reject);
    request.end();
  });

const LOCAL_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp)$/i;

function validateUrl(raw: string, config: FetcherConfig): { url: URL } | { reason: FetchFailure } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { reason: "unsupported_scheme" };
  if (url.username || url.password) return { reason: "credentials_in_url" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return { reason: "ip_literal_host" };
  if (!host.includes(".") || LOCAL_HOST.test(host)) return { reason: "blocked_hostname" };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!config.allowedPorts.includes(port)) return { reason: "port_not_allowed" };
  url.hash = "";
  return { url };
}

function header(headers: TransportResponse["headers"], name: string): string | null {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

class FetchAbort extends Error {
  constructor(readonly reason: FetchFailure, readonly detail: string | null = null) {
    super(reason);
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new FetchAbort("timeout"));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new FetchAbort("timeout")), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readBody(response: TransportResponse, config: FetcherConfig, deadline: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  for (;;) {
    const next = await withDeadline(iterator.next(), deadline);
    if (next.done) break;
    total += next.value.byteLength;
    if (total > config.maxBytes) throw new FetchAbort("response_too_large", `> ${config.maxBytes} bytes`);
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

function decompress(raw: Buffer, encoding: string | null, config: FetcherConfig): Buffer {
  const value = (encoding ?? "identity").trim().toLowerCase();
  const options = { maxOutputLength: config.maxBytes };
  try {
    if (value === "identity" || value === "") return raw;
    if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(raw, options);
    if (value === "deflate") return zlib.inflateSync(raw, options);
    if (value === "br") return zlib.brotliDecompressSync(raw, options);
  } catch (error) {
    const tooLarge = error instanceof RangeError || /maxOutputLength|buffer|too large/i.test(String(error));
    throw new FetchAbort(tooLarge ? "response_too_large" : "decompression_failed", String(error).slice(0, 120));
  }
  throw new FetchAbort("unsupported_encoding", value);
}

function decodeText(bytes: Buffer, charset: string): { text: string; charset: string } {
  try {
    return { text: new TextDecoder(charset, { fatal: false }).decode(bytes), charset: charset.toLowerCase() };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
  }
}

/**
 * Fetches one observed URL. Never throws: every outcome, allowed or blocked,
 * is returned with the per-hop decisions.
 */
export async function safeFetch(
  requestedUrl: string,
  options: { config?: FetcherConfig; resolver?: Resolver; transport?: Transport; now?: () => Date } = {},
): Promise<SafeFetchResult> {
  const config = options.config ?? FETCHER_CONFIG;
  const resolver = options.resolver ?? defaultResolver;
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + config.timeoutMs;
  const decisions: FetchDecision[] = [];
  const redirects: Array<{ from: string; to: string; status: number }> = [];
  let checks = notReached();
  const fail = (reason: FetchFailure, detail: string | null = null): SafeFetchResult => ({ ok: false, requestedUrl, reason, detail, redirects, decisions, responseChecks: checks });
  const headers = { "user-agent": config.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "gzip, deflate, br" };

  let current = requestedUrl;
  for (let hop = 0; ; hop += 1) {
    const validated = validateUrl(current, config);
    if ("reason" in validated) {
      decisions.push({ url: current, host: null, addresses: [], allowed: false, reason: validated.reason });
      return fail(validated.reason);
    }
    const { url } = validated;
    let addresses: ResolvedAddress[];
    try {
      addresses = await withDeadline(resolver(url.hostname), deadline);
    } catch (error) {
      const reason = error instanceof FetchAbort ? error.reason : "dns_failure";
      decisions.push({ url: url.toString(), host: url.hostname, addresses: [], allowed: false, reason });
      return fail(reason, error instanceof FetchAbort ? null : String(error).slice(0, 120));
    }
    const list = addresses.map((entry) => entry.address);
    if (addresses.length === 0) {
      decisions.push({ url: url.toString(), host: url.hostname, addresses: list, allowed: false, reason: "no_addresses" });
      return fail("no_addresses");
    }
    // Every resolved address must be public; a mixed answer is refused outright.
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      decisions.push({ url: url.toString(), host: url.hostname, addresses: list, allowed: false, reason: "resolves_to_blocked_address" });
      return fail("resolves_to_blocked_address", list.join(","));
    }
    decisions.push({ url: url.toString(), host: url.hostname, addresses: list, allowed: true, reason: null });

    let response: TransportResponse;
    try {
      response = await withDeadline(transport({ url, address: addresses[0].address, family: addresses[0].family, headers }), deadline);
    } catch (error) {
      return error instanceof FetchAbort ? fail(error.reason) : fail("transport_error", String(error).slice(0, 120));
    }

    checks = { ...notReached(), httpStatus: response.status };
    try {
      if (response.status >= 300 && response.status < 400) {
        response.destroy();
        const location = header(response.headers, "location");
        if (!location) return fail("redirect_without_location", String(response.status));
        if (hop >= config.maxRedirects) return fail("too_many_redirects", String(hop + 1));
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return fail("invalid_url", location.slice(0, 200));
        }
        redirects.push({ from: url.toString(), to: next, status: response.status });
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.destroy();
        checks.status = "failed";
        return fail("http_status", String(response.status));
      }
      checks.status = "passed";
      const contentTypeHeader = header(response.headers, "content-type");
      if (!contentTypeHeader) {
        response.destroy();
        checks.contentType = "failed";
        return fail("missing_content_type");
      }
      const [mediaType, ...params] = contentTypeHeader.split(";").map((part) => part.trim());
      checks.mediaType = mediaType.toLowerCase();
      if (!config.allowedContentTypes.includes(mediaType.toLowerCase())) {
        response.destroy();
        checks.contentType = "failed";
        return fail("unsupported_content_type", mediaType);
      }
      checks.contentType = "passed";
      const declared = Number(header(response.headers, "content-length"));
      if (Number.isFinite(declared) && declared > config.maxBytes) {
        response.destroy();
        checks.size = "failed";
        return fail("response_too_large", `content-length ${declared}`);
      }
      let raw: Buffer;
      try {
        raw = await readBody(response, config, deadline);
      } catch (error) {
        if (error instanceof FetchAbort && error.reason === "response_too_large") checks.size = "failed";
        throw error;
      }
      let bytes: Buffer;
      try {
        bytes = decompress(raw, header(response.headers, "content-encoding"), config);
      } catch (error) {
        if (error instanceof FetchAbort) checks[error.reason === "response_too_large" ? "size" : "encoding"] = "failed";
        throw error;
      }
      checks.encoding = "passed";
      checks.size = "passed";
      checks.bytes = bytes.byteLength;
      const charsetParam = params.find((param) => /^charset=/i.test(param));
      const { text, charset } = decodeText(bytes, charsetParam ? charsetParam.slice(8).replace(/"/g, "").trim() : "utf-8");
      return {
        ok: true,
        requestedUrl,
        finalUrl: url.toString(),
        status: response.status,
        contentType: mediaType.toLowerCase(),
        charset,
        bytes: bytes.byteLength,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        body: text,
        redirects,
        decisions,
        responseChecks: checks,
        retrievedAt: now().toISOString(),
      };
    } catch (error) {
      response.destroy();
      return error instanceof FetchAbort ? fail(error.reason, error.detail) : fail("transport_error", String(error).slice(0, 120));
    }
  }
}
