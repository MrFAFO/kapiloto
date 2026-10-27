import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/**
 * Offline guard for replay and plan (defence in depth; the replay import graph
 * is already network-free): every outbound primitive throws, including name
 * resolution, so nothing can leave the process or reach a DNS server.
 * Returns a function that restores the originals (used by tests).
 */

const DNS_FUNCTIONS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
] as const;

export function blockAllNetwork(label = "network"): () => void {
  const restore: Array<() => void> = [];
  const patch = (target: object, key: string, what: string) => {
    const record = target as Record<string, unknown>;
    if (!(key in record)) return;
    const original = Object.getOwnPropertyDescriptor(record, key);
    Object.defineProperty(record, key, {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error(`${label}_blocked: ${what}`);
      },
    });
    restore.push(() => (original ? Object.defineProperty(record, key, original) : delete record[key]));
  };

  patch(globalThis, "fetch", "fetch");
  for (const [name, module] of [["http", http], ["https", https]] as const) {
    patch(module, "request", `${name}.request`);
    patch(module, "get", `${name}.get`);
  }
  patch(net, "connect", "net.connect");
  patch(net, "createConnection", "net.createConnection");
  patch(tls, "connect", "tls.connect");

  // node:dns, node:dns/promises (also reachable as dns.promises) and both Resolver classes.
  const dnsTargets: Array<[object, string]> = [
    [dns, "dns"],
    [dnsPromises, "dns.promises"],
    [dns.Resolver.prototype, "dns.Resolver"],
    [dnsPromises.Resolver.prototype, "dns.promises.Resolver"],
  ];
  if (dns.promises !== dnsPromises) dnsTargets.push([dns.promises, "dns.promises"]);
  for (const [target, name] of dnsTargets) {
    for (const key of DNS_FUNCTIONS) patch(target, key, `${name}.${key}`);
  }

  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
