// Shared types for the lockwire core. See LOCKWIRE-SPEC.md — this file is the TS mirror of §2, §4, §5.

export type Tier = "path" | "sig" | "body" | "deps";
export const ALL_TIERS: readonly Tier[] = ["path", "sig", "body", "deps"];

export type AnchorStatus = "fresh" | "drifted" | "relocated" | "orphaned" | "waived" | "superseded";

export interface Fingerprints {
  path: string;
  sig: string;
  body: string;
  deps: string;
}

export interface ActorTool {
  name: string;
  version?: string;
}

/** An Agent Trace (agent-trace.dev v0.1.0) contributor. Ledger actors reuse this shape rather than inventing one. */
export interface Actor {
  type: "human" | "ai" | "mixed" | "unknown";
  model_id?: string;
  tool?: ActorTool;
  session?: string;
}

export interface AnchorTarget {
  path: string;
  symbol?: string;
}

export interface AnchorClaim {
  line: number;
  hash: string;
  /** Whitespace-insensitive hash of the claim text; absent on anchors linked before it existed. */
  normHash?: string;
  excerpt: string;
}

export interface Waiver {
  reason: string;
  expires: string;
  by: Actor;
}

export interface Anchor {
  id: string;
  doc: string | null;
  claim: AnchorClaim | null;
  target: AnchorTarget;
  tiers: Tier[];
  fingerprints: Fingerprints;
  linked: {
    at: string;
    commit: string | null;
    by: Actor;
  };
  status: AnchorStatus;
  waiver: Waiver | null;
}

export interface Lockfile {
  version: 1;
  anchors: Anchor[];
}

export type LedgerEvent =
  | "anchor.created"
  | "anchor.verified"
  | "anchor.drifted"
  | "anchor.relocated"
  | "anchor.resolved"
  | "anchor.orphaned"
  | "anchor.superseded"
  | "anchor.acknowledged"
  | "waiver.granted"
  | "waiver.expired";

export interface LedgerRecord {
  v: 1;
  id: string;
  ts: string;
  event: LedgerEvent;
  anchor: string;
  actor: Actor;
  tier?: Tier;
  from?: string;
  to?: string;
  commit?: string | null;
  note?: string;
  hash: string;
}

export interface LockwireConfig {
  version: 1;
  docs: string[];
  exclude: string[];
  normalizeLocals: boolean;
  hook: {
    mode: "advisory" | "ask" | "deny";
    maxClaimsInContext: number;
  };
}

export const DEFAULT_CONFIG: LockwireConfig = {
  version: 1,
  docs: ["**/*.md"],
  exclude: ["node_modules/**", "dist/**", "**/CHANGELOG.md"],
  normalizeLocals: true,
  hook: { mode: "advisory", maxClaimsInContext: 8 },
};

/** A symbol found in a source file, ready for tier extraction. Produced by extract.ts. */
export interface ResolvedSymbol {
  kind: string;
  name: string;
  exported: boolean;
  sigTokens: string;
  bodyText: string;
  bodyNormalized: string;
  deps: string[];
}

export interface FileSymbols {
  /** dotted-path name -> symbol, e.g. "createSession" or "AuthConfig.refresh" */
  bySymbolPath: Map<string, ResolvedSymbol>;
  fileExports: string[];
}
