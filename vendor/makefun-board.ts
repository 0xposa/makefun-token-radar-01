// makefun-board.ts — board builder for the token launch radar (token-radar-01).
// NOTE: for a formal make.fun submission this file is replaced by the kit's own
// vendor/makefun-board.ts; this is an independent implementation of the same job:
// read a DefiLlama-shaped snapshot, find the pre-token launch candidates, price
// what a launch would be worth, and emit board.json + dossier.json.

export interface Protocol {
  name: string;
  symbol?: string | null;
  tvl?: number | null;
  mcap?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  category?: string | null;
  chains?: string[] | null;
  url?: string | null;
  listedAt?: number | null; // unix seconds (DefiLlama)
  description?: string | null;
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
  implied_value: number;
  implied_multiple: number;
  model: { curve_value: number; category_value: number | null; growth_factor: number; breadth_factor: number };
  launch_score: number;
  verdict: "FARM" | "WATCH" | "SKIP";
  risk_flags: string[];
  url: string | null;
  description: string | null;
  farm_plan: FarmStep[];
}

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
const SNAPSHOT_DAY = 2026 * 10000 + 1123; // fallback "today" stamp when listedAt math needs one

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function isTokenless(p: Protocol): boolean {
  const s = (p.symbol ?? "").trim();
  return s === "" || s === "-";
}
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// Ordinary least squares on (ln tvl, ln mcap) over the tokenised peers.
export function fitCurve(peers: Protocol[]): { a: number; b: number; n: number; r2: number } {
  const pts = peers
    .filter((p) => (p.tvl ?? 0) >= 1e6 && (p.mcap ?? 0) > 0)
    .map((p) => [Math.log(p.tvl as number), Math.log(p.mcap as number)] as const);
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
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
function farmPlan(p: Protocol, tvl: number, ageDays: number | null): FarmStep[] {
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

export function buildBoard(snapshot: Protocol[]): { board: BoardRow[]; dossier: Record<string, unknown> } {
  const peers = snapshot.filter((p) => !isTokenless(p));
  const curve = fitCurve(peers);
  const catMult = new Map<string, number>();
  const catPeerShare = new Map<string, number>();
  {
    const byCat = new Map<string, { mult: number[]; tok: number; all: number }>();
    for (const p of snapshot) {
      const c = p.category ?? "Other";
      const e = byCat.get(c) ?? { mult: [], tok: 0, all: 0 };
      e.all++;
      if (!isTokenless(p)) { e.tok++; if ((p.tvl ?? 0) >= 1e6 && (p.mcap ?? 0) > 0) e.mult.push((p.mcap as number) / (p.tvl as number)); }
      byCat.set(c, e);
    }
    for (const [c, e] of byCat) { if (e.mult.length >= 3) catMult.set(c, median(e.mult)); catPeerShare.set(c, e.tok / Math.max(1, e.all)); }
  }
  const tokenisedNames = peers.map((p) => p.name.toLowerCase());
  const nowSec = Math.floor(Date.UTC(2026, 10, 23) / 1000); // fixed stamp: deterministic runs

  const candidates = snapshot.filter((p) => {
    if (!isTokenless(p)) return false;
    const tvl = p.tvl ?? 0;
    if (tvl < 5e6) return false;
    const cat = p.category ?? "Other";
    if (EXCLUDED_CATEGORIES.has(cat)) return false;
    const nm = p.name.toLowerCase();
    if (WRAPPER_WORDS.some((w) => nm.includes(w))) return false;
    // a wrapper/staked product of a protocol that already trades carries its parent's name
    if (tokenisedNames.some((tn) => tn.length >= 5 && nm !== tn && nm.includes(tn))) return false;
    return true;
  });

  const rows: BoardRow[] = candidates.map((p) => {
    const tvl = p.tvl as number;
    const cat = p.category ?? "Other";
    const chains = p.chains ?? [];
    const curveValue = Math.exp(curve.a + curve.b * Math.log(tvl));
    const cm = catMult.get(cat);
    const categoryValue = cm ? tvl * cm : null;
    let implied = categoryValue ? Math.sqrt(curveValue * categoryValue) : curveValue;
    const growth = 1 + (clamp(p.change_7d ?? 0, -60, 120) / 100) * 0.35;
    const breadth = 1 + Math.min(Math.max(chains.length - 1, 0), 7) * 0.02;
    implied *= growth * breadth;
    const ageDays = p.listedAt ? Math.max(0, Math.round((nowSec - p.listedAt) / 86400)) : null;
    const breadthScore = Math.min(chains.length, 8) / 8;
    const precedent = catPeerShare.get(cat) ?? 0.2;
    const maturity = ageDays === null ? 0.5 : clamp(ageDays / 1095, 0, 1);
    // TVL and growth enter as percentiles across the candidate set (filled in
    // below, once every candidate is known); store the raw parts meanwhile.
    const score = Math.round(100 * (0.15 * breadthScore + 0.15 * precedent + 0.1 * maturity));
    const flags: string[] = [];
    if (chains.length <= 1) flags.push("Single-chain concentration");
    if ((p.change_7d ?? 0) < -10) flags.push("TVL falling fast (7d < -10%)");
    if (ageDays !== null && ageDays < 90) flags.push("Very young listing (<90 days)");
    if (!p.url) flags.push("No public site on record");
    if (precedent < 0.25) flags.push("Few token precedents in category");
    return {
      rank: 0, slug: slugify(p.name), name: p.name, category: cat, chains,
      main_chain: chains[0] ?? "—", tvl,
      change_1d: p.change_1d ?? null, change_7d: p.change_7d ?? null,
      age_days: ageDays, watchlist: tvl >= 5e7,
      implied_value: Math.round(implied), implied_multiple: Math.round((implied / tvl) * 1000) / 1000,
      model: { curve_value: Math.round(curveValue), category_value: categoryValue ? Math.round(categoryValue) : null, growth_factor: Math.round(growth * 1000) / 1000, breadth_factor: Math.round(breadth * 1000) / 1000 },
      launch_score: score, verdict: score >= 65 ? "FARM" : score >= 45 ? "WATCH" : "SKIP",
      risk_flags: flags, url: p.url ?? null, description: p.description ?? null,
      farm_plan: farmPlan(p, tvl, ageDays),
    };
  });
  // Percentile rescoring: TVL (log scale) and 7d growth ranked across the board.
  {
    const pct = (xs: number[], v: number) => xs.filter((x) => x <= v).length / Math.max(1, xs.length);
    const logTvls = rows.map((r) => Math.log10(r.tvl));
    const growths = rows.map((r) => r.change_7d ?? 0);
    for (const r of rows) {
      r.launch_score += Math.round(100 * (0.4 * pct(logTvls, Math.log10(r.tvl)) + 0.2 * pct(growths, r.change_7d ?? 0)));
      r.verdict = r.launch_score >= 65 ? "FARM" : r.launch_score >= 45 ? "WATCH" : "SKIP";
    }
  }
  rows.sort((x, y) => y.implied_value - x.implied_value || y.tvl - x.tvl);
  rows.forEach((r, i) => (r.rank = i + 1));

  const dossier = {
    generated_from: "DefiLlama-shaped protocol snapshot (sealed snapshot at grading; live api.llama.fi/protocols extract for the local build)",
    snapshot_protocols: snapshot.length,
    peers_with_market_cap: curve.n,
    board_rows: rows.length,
    watchlist_rows: rows.filter((r) => r.watchlist).length,
    combined_tvl: Math.round(rows.reduce((s, r) => s + r.tvl, 0)),
    combined_implied_value: rows.reduce((s, r) => s + r.implied_value, 0),
    model: {
      name: "curve-blend-1",
      formula: "implied = geometric_mean(exp(a + b*ln TVL), TVL * category_median_multiple) * growth * breadth",
      curve: { intercept_a: curve.a, slope_b: curve.b, peers: curve.n, r2: Math.round(curve.r2 * 10000) / 10000 },
      growth: "1 + clamp(change_7d, -60, 120)/100 * 0.35",
      breadth: "1 + min(chains-1, 7) * 0.02",
      launch_score: "100 * (0.40 log-TVL percentile across the board + 0.20 7d-growth percentile across the board + 0.15 breadth + 0.15 category token precedent + 0.10 maturity); FARM >= 65, WATCH >= 45",
    },
    funnel: {
      rule: "tokenless (symbol '-' or empty), TVL >= $5M, category not in the excluded set (CEX / bridges / staking wrappers), name not a wrapper word and not containing a tokenised parent's name",
      excluded_categories: [...EXCLUDED_CATEGORIES],
    },
    stamp: SNAPSHOT_DAY,
  };
  return { board: rows, dossier };
}
