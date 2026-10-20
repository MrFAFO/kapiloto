import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { normalizeEvidenceUrl, type SolFixtureResearchOutput } from "./research-output";
import type { RetrievedSourceDocument } from "./source-grounding";

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

type ResolvedTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }

  return (
    (((parts[0] << 24) >>> 0) +
      (parts[1] << 16) +
      (parts[2] << 8) +
      parts[3]) >>>
    0
  );
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(ip);
  const network = ipv4ToInt(base);
  if (value == null || network == null) return true;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function normalizeIpv6(ip: string): string {
  return ip.toLocaleLowerCase().split("%")[0];
}

export function isBlockedSourceAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];

    return blocked.some(([base, bits]) => inCidr4(address, base, bits));
  }

  if (family === 6) {
    const ip = normalizeIpv6(address);
    if (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip) ||
      ip.startsWith("ff") ||
      ip.startsWith("2001:db8:")
    ) {
      return true;
    }

    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedSourceAddress(mapped[1]);

    return false;
  }

  return true;
}

function validateSourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Evidence source must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Evidence source URL must not contain credentials.");
  }
  if (
    (url.protocol === "https:" && url.port && url.port !== "443") ||
    (url.protocol === "http:" && url.port && url.port !== "80")
  ) {
    throw new Error("Evidence source URL uses a non-standard port.");
  }
  return url;
}

async function resolvePublicTarget(raw: string): Promise<ResolvedTarget> {
  const url = validateSourceUrl(raw);
  const records = await lookup(url.hostname, { all: true, verbatim: true });

  if (records.length === 0) {
    throw new Error("Evidence source hostname did not resolve.");
  }
  if (records.some((record) => isBlockedSourceAddress(record.address))) {
    throw new Error("Evidence source resolved to a blocked network address.");
  }

  const selected = records[0];
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function firstPublishedAt(html: string): string | null {
  const patterns = [
    /<meta\s+[^>]*(?:property|name)=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']article:published_time["'][^>]*>/i,
    /<meta\s+[^>]*(?:property|name)=["'](?:date|datepublished|publishdate|pubdate)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time\s+[^>]*datetime=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }

  return null;
}

function requestPinned(
  target: ResolvedTarget,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.protocol === "https:";
    const transport = isHttps ? https : http;

    const request = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        family: target.family,
        port: isHttps ? 443 : 80,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        servername: isHttps ? target.url.hostname : undefined,
        headers: {
          Host: target.url.host,
          Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": "KapilotoResearchVerifier/1.0",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_SOURCE_BYTES) {
            request.destroy(new Error("Evidence source exceeded size limit."));
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Evidence source request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchSource(
  requestedUrl: string,
  redirectsLeft = MAX_REDIRECTS,
  originalRequestedUrl = requestedUrl,
): Promise<RetrievedSourceDocument> {
  const target = await resolvePublicTarget(requestedUrl);
  const response = await requestPinned(target);

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.location
  ) {
    if (redirectsLeft <= 0) {
      throw new Error("Evidence source exceeded redirect limit.");
    }
    const redirected = new URL(response.headers.location, target.url).toString();
    return fetchSource(redirected, redirectsLeft - 1, originalRequestedUrl);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Evidence source returned HTTP ${response.status}.`);
  }

  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new Error(`Unsupported evidence content type: ${contentType}`);
  }

  const finalUrl = normalizeEvidenceUrl(target.url.toString());
  const text = contentType.includes("text/plain")
    ? response.body.replace(/\s+/g, " ").trim()
    : htmlToText(response.body);

  return {
    requestedUrl: normalizeEvidenceUrl(originalRequestedUrl),
    finalUrl,
    retrievedAt: new Date().toISOString(),
    publishedAt: firstPublishedAt(response.body),
    text,
    contentSha256: createHash("sha256").update(response.body).digest("hex"),
  };
}

export type SourceRetrievalResult = {
  documents: RetrievedSourceDocument[];
  failures: Array<{ url: string; error: string }>;
};

export async function retrieveResearchSourceDocuments(
  output: SolFixtureResearchOutput,
): Promise<SourceRetrievalResult> {
  const urls = [
    ...new Set(
      output.evidence.map((item) => normalizeEvidenceUrl(item.url)),
    ),
  ];

  const documents: RetrievedSourceDocument[] = [];
  const failures: Array<{ url: string; error: string }> = [];

  // Keep concurrency deliberately low. Evidence pages are small and this path
  // should not become a general-purpose web proxy.
  for (let index = 0; index < urls.length; index += 4) {
    const batch = urls.slice(index, index + 4);
    const results = await Promise.allSettled(
      batch.map((url) => fetchSource(url)),
    );

    results.forEach((result, resultIndex) => {
      const url = batch[resultIndex];
      if (result.status === "fulfilled") {
        documents.push(result.value);
      } else {
        failures.push({
          url,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
  }

  return { documents, failures };
}

export const __testOnly = {
  validateSourceUrl,
  htmlToText,
  firstPublishedAt,
};
