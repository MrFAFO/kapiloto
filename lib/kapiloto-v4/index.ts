// Kapiloto V4 foundation: canonical entities, the bitemporal Match Ledger
// (1A), the document/claim knowledge registry and the prediction registry
// (1B), roster membership and the deterministic pre-match squad state (1C),
// the lineup forecast baseline with Prediction Registry V2 (1D), and the
// provider-native Match Ledger ingest with strict team match stats (1E-A2-A).
// The retrospective training read (./training) is deliberately not exported.
// Not wired into V3 research yet; lib/kapiloto must not import this module.
export * from "./versions";
export * from "./aliases";
export * from "./entities";
export * from "./match-ledger";
export * from "./as-of";
export * from "./documents";
export * from "./claims";
export * from "./prediction-registry";
export * from "./roster";
export * from "./squad-state";
export * from "./canonical-json";
export * from "./lineup-model";
export * from "./lineup-scoring";
export * from "./lineup-snapshot";
export * from "./provider-ingest";
export * from "./sportmonks-ledger";
export * from "./team-match-stats";
