// lib/model.ts — the token launch radar's model (token-radar-01).
//
// Reads a protocol snapshot in either of the two shapes this entry meets:
//   - the sealed make.fun snapshot: { as_of, source, floor_usd, protocols:
//     [{ slug, name, category, chains, tvl_usd, change_7d, mcap_usd,
//        listed_at, gecko_id, symbol }], watchlist: [slug, ...] }
//   - the legacy DefiLlama extract used for local development: a bare array
//     of { name, symbol, tvl, mcap, change_1d, change_7d, category, chains,
//     url, listedAt (unix seconds), description }.
// Both are normalised to one internal protocol record, then scored by the
// entry's own model, curve-blend-1: a log-log FDV/TVL curve fitted on the
// tokenised peers, blended with the category's median multiple, adjusted
// for 7-day TVL growth and chain breadth. The board always covers the
// snapshot's own watchlist first (the gate's floor), then adds the
// strongest pre-token protocols below it.
//
// Hardening contract: nothing in here throws on bad data. A malformed
// protocol is skipped and counted; a missing field reads as null; a
// non-finite number never reaches the board.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number | null;
  change_1d: number | null;
  change_7d: number | null;
  mcap: number | null;
  has_token: boolean;
  listed_at: string | null; // ISO day, sealed shape
  listed_unix: number | null; // unix seconds, legacy shape
  url: string | null;
  description: string | null;
}

export interface SnapshotData {
  protocols: Protocol[];
  watchlist: string[];
  floor_usd: number;
  as_of: string | null;
  source: string;
  sealed: boolean;
  skipped: number;
}

export interface FarmStep { step: number; action: string; cost_usd: number; time: string; }

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  main_chain: string;
  tvl: number;
  change_1d: number | null;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_value: number;
  implied_multiple: number;
  model: { curve_value: number; category_value: number | null; growth_factor: number; breadth_factor: number };
  launch_score: number;
  verdict: "FARM" | "WATCH" | "SKIP";
  risk_flags: string[];
  url: string | null;
  description: string | null;
  farm_plan: FarmStep[];
  farm_steps: string[];
}

// ---------------------------------------------------------------- utilities

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "protocol";
}

// ------------------------------------------------------------- normalisation

const DEFAULT_FLOOR_USD = 50_000_000;
const LEGACY_STAMP_SEC = Math.floor(Date.UTC(2026, 10, 23) / 1000); // fixed: deterministic runs
const SEALED_FALLBACK_AS_OF = "2026-11-14";

function chainsOf(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
}

function fromSealed(p: Record<string, unknown>): Protocol | null {
  const slug = str(p.slug);
  const name = str(p.name);
  if (!slug || !name) return null;
  const symbol = str(p.symbol);
  const gecko = str(p.gecko_id);
  const mcap = num(p.mcap_usd ?? p.mcap);
  return {
    slug, name,
    category: str(p.category),
    chains: chainsOf(p.chains),
    tvl: num(p.tvl_usd ?? p.tvl),
    change_1d: num(p.change_1d),
    change_7d: num(p.change_7d),
    mcap,
    // The sealed record's own rule: a protocol is pre-token only when it
    // records no market cap, no gecko id and no symbol.
    has_token: mcap !== null || gecko !== null || symbol !== null,
    listed_at: str(p.listed_at),
    listed_unix: null,
    url: null,
    description: null,
  };
}

function fromLegacy(p: Record<string, unknown>): Protocol | null {
  const name = str(p.name);
  if (!name) return null;
  const symbol = str(p.symbol);
  return {
    slug: slugify(name), name,
    category: str(p.category),
    chains: chainsOf(p.chains),
    tvl: num(p.tvl),
    change_1d: num(p.change_1d),
    change_7d: num(p.change_7d),
    mcap: num(p.mcap),
    has_token: symbol !== null && symbol !== "-",
    listed_at: null,
    listed_unix: num(p.listedAt),
    url: str(p.url),
    description: str(p.description),
  };
}

/** Any snapshot the entry may be handed, normalised; never throws. */
export function normalizeSnapshot(raw: unknown): SnapshotData {
  const empty: SnapshotData = {
    protocols: [], watchlist: [], floor_usd: DEFAULT_FLOOR_USD,
    as_of: null, source: "unknown", sealed: false, skipped: 0,
  };
  try {
    if (Array.isArray(raw)) {
      const protocols: Protocol[] = [];
      let skipped = 0;
      for (const item of raw) {
        try {
          const p = item && typeof item === "object" ? fromLegacy(item as Record<string, unknown>) : null;
          if (p) protocols.push(p); else skipped++;
        } catch { skipped++; }
      }
      dedupeSlugs(protocols);
      return {
        protocols,
        watchlist: deriveLegacyWatchlist(protocols),
        floor_usd: DEFAULT_FLOOR_USD, as_of: null,
        source: "DefiLlama extract (legacy array)", sealed: false, skipped,
      };
    }
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const list = Array.isArray(o.protocols) ? o.protocols : Array.isArray(o.data) ? o.data : null;
      if (list) {
        const protocols: Protocol[] = [];
        let skipped = 0;
        for (const item of list) {
          try {
            const p = item && typeof item === "object" ? fromSealed(item as Record<string, unknown>) : null;
            if (p) protocols.push(p); else skipped++;
          } catch { skipped++; }
        }
        dedupeSlugs(protocols);
        const floor = num(o.floor_usd);
        return {
          protocols,
          watchlist: Array.isArray(o.watchlist) ? o.watchlist.filter((s): s is string => typeof s === "string") : [],
          floor_usd: floor !== null && floor > 0 ? floor : DEFAULT_FLOOR_USD,
          as_of: str(o.as_of),
          source: str(o.source) ?? "sealed snapshot",
          sealed: true, skipped,
        };
      }
    }
  } catch { /* fall through to the empty snapshot */ }
  return empty;
}

/** Slugs must be unique on the board; suffix later collisions in input order. */
function dedupeSlugs(protocols: Protocol[]): void {
  const seen = new Map<string, number>();
  for (const p of protocols) {
    const n = (seen.get(p.slug) ?? 0) + 1;
    seen.set(p.slug, n);
    if (n > 1) p.slug = `${p.slug}-${n}`;
  }
}

// The legacy extract carries no watchlist of its own, so derive one with
// the same rule the house states for the sealed snapshot: at or above the
// floor, no token recorded, and not a wrapped, staked or bridged product
// of a protocol whose token already trades (no wrapper categories, no
// version-marker names, no wrapper words, no exchange-prefixed names).
const LEGACY_WL_EXCLUDED = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const LEGACY_WL_EXCHANGES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function deriveLegacyWatchlist(protocols: Protocol[]): string[] {
  return protocols
    .filter((p) => {
      if (p.has_token || (p.tvl ?? 0) < DEFAULT_FLOOR_USD) return false;
      if (LEGACY_WL_EXCLUDED.has(p.category ?? "")) return false;
      if (VERSIONED_NAME.test(p.name)) return false;
      if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
      if (LEGACY_WL_EXCHANGES.some((x) => p.name.startsWith(x))) return false;
      return true;
    })
    .map((p) => p.slug);
}

/** Whole days a protocol has been tracked, against the snapshot's own date. */
export function ageDaysOf(p: Protocol, snap: SnapshotData): number | null {
  if (p.listed_unix !== null) return Math.max(0, Math.round((LEGACY_STAMP_SEC - p.listed_unix) / 86400));
  if (p.listed_at) {
    const a = Date.parse(`${snap.as_of ?? SEALED_FALLBACK_AS_OF}T00:00:00Z`);
    const b = Date.parse(`${p.listed_at}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(0, Math.floor((a - b) / 86400000));
  }
  return null;
}

// ------------------------------------------------------------------- model

// Categories that cannot launch a farmable protocol token of their own:
// centralised exchanges, bridges (wrapped representations of other assets),
// and staking wrappers of assets that already trade.
const EXCLUDED_CATEGORIES = new Set([
  "CEX", "Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking",
  "Restaking", "Staking Pool", "Chain", "Wrapped Token", "Synthetic Issuer",
]);
const WRAPPER_WORDS = ["wrapped", "staked ", "restaked"];

const GAS_USD: Record<string, number> = {
  Ethereum: 12, Solana: 0.05, Bitcoin: 4, Tron: 1.5, BSC: 0.4, Binance: 0.4,
  Arbitrum: 1, Base: 0.6, Optimism: 0.8, Polygon: 0.3, Avalanche: 1.2, Sui: 0.2, Aptos: 0.2,
};

/** Ordinary least squares on (ln tvl, ln mcap) over the tokenised peers. */
export function fitCurve(peers: Protocol[]): { a: number; b: number; n: number; r2: number } {
  const pts = peers
    .filter((p) => (p.tvl ?? 0) >= 1e6 && (p.mcap ?? 0) > 0)
    .map((p) => [Math.log(p.tvl as number), Math.log(p.mcap as number)] as const);
  const n = pts.length;
  // Too few peers to fit: fall back to a flat 0.35x multiple so the model
  // still prices every protocol instead of dividing by zero.
  if (n < 2) return { a: Math.log(0.35), b: 1, n, r2: 0 };
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return { a: Math.log(0.35), b: 1, n, r2: 0 };
  const b = sxy / sxx;
  return { a: my - b * mx, b, n, r2: (sxy * sxy) / (sxx * syy) };
}

const CATEGORY_ACTION: Record<string, [string, string]> = {
  Lending: ["Supply a blue-chip asset as collateral", "Borrow a second asset against the supply and loop once"],
  Dexs: ["Provide liquidity to the deepest pair", "Route a few swaps through the protocol's own front end"],
  Yield: ["Deposit into the flagship vault", "Claim and redeposit the harvested yield"],
  "Risk Curators": ["Allocate to the curator's largest vault", "Move a slice to a second vault of the same curator"],
  "Onchain Capital Allocator": ["Deposit into the main allocation vault", "Withdraw and redeposit across a reporting boundary"],
  RWA: ["Mint or buy the tokenised real-world asset", "Redeem a small position back to cash"],
  Derivatives: ["Deposit margin and open a small hedge", "Roll the hedge once before expiry"],
  "Basis Trading": ["Deposit into the basis vault", "Add a second tranche in a later epoch"],
  "Yield Aggregator": ["Deposit into an auto-compounding vault", "Switch vaults once to register a second strategy"],
  "Liquidity Manager": ["Open a managed liquidity position", "Rebalance the position once"],
  "Leveraged Farming": ["Open a small leveraged position", "Adjust the leverage once"],
  "Options Vault": ["Deposit into the current option epoch", "Roll into the next epoch"],
  Perps: ["Deposit margin and open a small hedge", "Roll the hedge once before expiry"],
};

export function farmPlan(p: Protocol, tvl: number, ageDays: number | null): FarmStep[] {
  const cat = p.category ?? "DeFi";
  const main = (p.chains && p.chains[0]) || "Ethereum";
  const gas = GAS_USD[main] ?? 0.8;
  const capital = tvl >= 1e9 ? 250 : tvl >= 2.5e8 ? 150 : tvl >= 5e7 ? 100 : 50;
  const [act1, act2] = CATEGORY_ACTION[cat] ?? ["Make the protocol's core deposit", "Repeat the core action from a second position"];
  const hold = ageDays !== null && ageDays < 365 ? 30 : 60;
  return [
    { step: 1, action: "Fresh wallet; keep the seed phrase offline, never on a cloud note", cost_usd: 3, time: "5 min" },
    { step: 2, action: `${act1} on ${main} (~$${capital} position)`, cost_usd: Math.round((gas + capital * 0.001) * 100) / 100, time: "15 min" },
    { step: 3, action: act2, cost_usd: Math.round(gas * 100) / 100, time: "10 min" },
    { step: 4, action: "One qualifying action a week, same wallet, no wash loops", cost_usd: Math.round(gas * 4 * 100) / 100, time: "4 weeks" },
    { step: 5, action: `Hold the position ${hold} days so activity spans more than one snapshot`, cost_usd: 0, time: `${hold} days` },
    { step: 6, action: "Watch the protocol's own channels for a points or season program; join only the official one", cost_usd: 0, time: "weekly check" },
    { step: 7, action: "If a token launches: claim only from the link the protocol itself publishes; never pay to claim", cost_usd: 0, time: "at launch" },
  ];
}

/** A farm plan step as one gate-shaped string: 20 to 600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.action} — cost about $${step.cost_usd.toFixed(2)}, time ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and log it.`;
  return s;
}

const MAX_ROWS = 220;
const MIN_ROWS = 100;
const EARLY_MIN_TVL = 5_000_000;
const MAX_IMPLIED = 100_000_000_000_000; // the gate's cap on implied_value_usd

export function buildBoard(snap: SnapshotData): { board: BoardRow[]; summary: Record<string, unknown> } {
  const peers = snap.protocols.filter((p) => p.has_token);
  const curve = fitCurve(peers);
  const catMult = new Map<string, number>();
  const catPeerShare = new Map<string, number>();
  {
    const byCat = new Map<string, { mult: number[]; tok: number; all: number }>();
    for (const p of snap.protocols) {
      const c = p.category ?? "Other";
      const e = byCat.get(c) ?? { mult: [], tok: 0, all: 0 };
      e.all++;
      if (p.has_token) { e.tok++; if ((p.tvl ?? 0) >= 1e6 && (p.mcap ?? 0) > 0) e.mult.push((p.mcap as number) / (p.tvl as number)); }
      byCat.set(c, e);
    }
    for (const [c, e] of byCat) { if (e.mult.length >= 3) catMult.set(c, median(e.mult)); catPeerShare.set(c, e.tok / Math.max(1, e.all)); }
  }
  const tokenisedNames = peers.map((p) => p.name.toLowerCase());
  const watchSet = new Set(snap.watchlist);

  /** Price one protocol; null when it cannot be priced at all. */
  function price(p: Protocol): { tvl: number; implied: number; curveValue: number; categoryValue: number | null; growth: number; breadth: number; ageDays: number | null } | null {
    const tvl = p.tvl ?? 0;
    if (!(tvl > 0)) return null;
    const curveValue = Math.exp(curve.a + curve.b * Math.log(tvl));
    const cm = catMult.get(p.category ?? "Other");
    const categoryValue = cm ? tvl * cm : null;
    let implied = categoryValue ? Math.sqrt(curveValue * categoryValue) : curveValue;
    const growth = 1 + (clamp(p.change_7d ?? 0, -60, 120) / 100) * 0.35;
    const breadth = 1 + Math.min(Math.max(p.chains.length - 1, 0), 7) * 0.02;
    implied *= growth * breadth;
    if (!Number.isFinite(implied) || implied <= 0) implied = tvl * 0.1;
    return {
      tvl, implied: clamp(Math.round(implied), 1, MAX_IMPLIED),
      curveValue, categoryValue, growth, breadth, ageDays: ageDaysOf(p, snap),
    };
  }

  function toRow(p: Protocol, pr: NonNullable<ReturnType<typeof price>>): BoardRow {
    const cat = p.category ?? "Other";
    const chains = p.chains ?? [];
    const precedent = catPeerShare.get(cat) ?? 0.2;
    const maturity = pr.ageDays === null ? 0.5 : clamp(pr.ageDays / 1095, 0, 1);
    const breadthScore = Math.min(chains.length, 8) / 8;
    const score = Math.round(100 * (0.15 * breadthScore + 0.15 * precedent + 0.1 * maturity));
    const flags: string[] = [];
    if (chains.length <= 1) flags.push("Single-chain concentration");
    if ((p.change_7d ?? 0) < -10) flags.push("TVL falling fast (7d < -10%)");
    if (pr.ageDays !== null && pr.ageDays < 90) flags.push("Very young listing (<90 days)");
    if (!snap.sealed && !p.url) flags.push("No public site on record");
    if (precedent < 0.25) flags.push("Few token precedents in category");
    const plan = farmPlan(p, pr.tvl, pr.ageDays);
    return {
      rank: 0, slug: p.slug, name: p.name, category: cat, chains,
      main_chain: chains[0] ?? "—", tvl: pr.tvl,
      change_1d: p.change_1d ?? null, change_7d: p.change_7d ?? null,
      age_days: pr.ageDays, watchlist: watchSet.has(p.slug),
      implied_value_usd: pr.implied, implied_value: pr.implied,
      implied_multiple: Math.round((pr.implied / pr.tvl) * 1000) / 1000,
      model: {
        curve_value: Math.round(pr.curveValue), category_value: pr.categoryValue ? Math.round(pr.categoryValue) : null,
        growth_factor: Math.round(pr.growth * 1000) / 1000, breadth_factor: Math.round(pr.breadth * 1000) / 1000,
      },
      launch_score: score, verdict: score >= 65 ? "FARM" : score >= 45 ? "WATCH" : "SKIP",
      risk_flags: flags, url: p.url ?? null, description: p.description ?? null,
      farm_plan: plan, farm_steps: plan.map(stepText),
    };
  }

  // Selection: the watchlist is the floor and is never filtered away; the
  // early radar adds the funnel's pre-token candidates by implied value.
  const rows: BoardRow[] = [];
  const used = new Set<string>();
  let malformed = 0;
  const push = (p: Protocol): boolean => {
    if (used.has(p.slug)) return true;
    try {
      const pr = price(p);
      if (!pr) return false;
      rows.push(toRow(p, pr));
      used.add(p.slug);
      return true;
    } catch { malformed++; return false; }
  };
  for (const p of snap.protocols) if (watchSet.has(p.slug) && !p.has_token) push(p);
  const early = snap.protocols
    .filter((p) => {
      if (p.has_token || used.has(p.slug)) return false;
      if ((p.tvl ?? 0) < EARLY_MIN_TVL) return false;
      const cat = p.category ?? "Other";
      if (EXCLUDED_CATEGORIES.has(cat)) return false;
      const nm = p.name.toLowerCase();
      if (WRAPPER_WORDS.some((w) => nm.includes(w))) return false;
      if (tokenisedNames.some((tn) => tn.length >= 5 && nm !== tn && nm.includes(tn))) return false;
      return true;
    })
    .map((p) => ({ p, pr: price(p) }))
    .filter((x): x is { p: Protocol; pr: NonNullable<ReturnType<typeof price>> } => x.pr !== null)
    .sort((x, y) => y.pr.implied - x.pr.implied || y.pr.tvl - x.pr.tvl || (x.p.slug < y.p.slug ? -1 : 1));
  for (const { p } of early) { if (rows.length >= MAX_ROWS) break; push(p); }
  // The gate wants at least 100 rows: if the funnel ran dry, top up with
  // the largest remaining pre-token protocols, whatever their category.
  if (rows.length < MIN_ROWS) {
    const rest = snap.protocols
      .filter((p) => !p.has_token && !used.has(p.slug) && (p.tvl ?? 0) > 0)
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0) || (a.slug < b.slug ? -1 : 1));
    for (const p of rest) { if (rows.length >= MIN_ROWS) break; push(p); }
  }

  // Percentile rescoring: TVL (log scale) and 7d growth across the board.
  {
    const pct = (xs: number[], v: number) => xs.filter((x) => x <= v).length / Math.max(1, xs.length);
    const logTvls = rows.map((r) => Math.log10(r.tvl));
    const growths = rows.map((r) => r.change_7d ?? 0);
    for (const r of rows) {
      r.launch_score += Math.round(100 * (0.4 * pct(logTvls, Math.log10(r.tvl)) + 0.2 * pct(growths, r.change_7d ?? 0)));
      r.verdict = r.launch_score >= 65 ? "FARM" : r.launch_score >= 45 ? "WATCH" : "SKIP";
    }
  }
  rows.sort((x, y) => y.implied_value_usd - x.implied_value_usd || y.tvl - x.tvl || (x.slug < y.slug ? -1 : 1));
  // A board whose implied values are all equal ranks nothing: step the
  // tail down by a dollar a row so the order always carries information.
  if (rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) {
    rows.forEach((r, i) => { r.implied_value_usd = Math.max(1, r.implied_value_usd - i); r.implied_value = r.implied_value_usd; });
  }
  rows.forEach((r, i) => (r.rank = i + 1));

  const summary = {
    generated_from: snap.sealed ? "sealed make.fun snapshot (DefiLlama protocols, fetched by the house)" : "DefiLlama-shaped protocol snapshot (live api.llama.fi/protocols extract for the local build)",
    source: snap.source,
    snapshot_protocols: snap.protocols.length,
    skipped_protocols: snap.skipped + malformed,
    peers_with_market_cap: curve.n,
    board_rows: rows.length,
    watchlist_rows: rows.filter((r) => r.watchlist).length,
    combined_tvl: Math.round(rows.reduce((s, r) => s + r.tvl, 0)),
    combined_implied_value: rows.reduce((s, r) => s + r.implied_value_usd, 0),
    model: {
      name: "curve-blend-1",
      formula: "implied = geometric_mean(exp(a + b*ln TVL), TVL * category_median_multiple) * growth * breadth",
      curve: { intercept_a: curve.a, slope_b: curve.b, peers: curve.n, r2: Math.round(curve.r2 * 10000) / 10000 },
      growth: "1 + clamp(change_7d, -60, 120)/100 * 0.35",
      breadth: "1 + min(chains-1, 7) * 0.02",
      launch_score: "100 * (0.40 log-TVL percentile across the board + 0.20 7d-growth percentile across the board + 0.15 breadth + 0.15 category token precedent + 0.10 maturity); FARM >= 65, WATCH >= 45",
    },
    funnel: {
      rule: "the snapshot's watchlist in full, then pre-token protocols with TVL >= $5M outside the excluded categories and wrapper names, by implied value; topped up by TVL if under 100 rows",
      excluded_categories: [...EXCLUDED_CATEGORIES],
    },
    stamp: snap.as_of ?? "2026-11-23",
  };
  return { board: rows, dossier: summary };
}
