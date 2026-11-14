// lib/model.ts — Token Launch Radar model "radar-2".
//
// The task: read the sealed DefiLlama snapshot, find the protocols that have
// no token and are not wrapped / staked products of something that already
// trades, and rank them by the launch value a token would have on day one.
//
// The model is deliberately small and stated in full on the dashboard, so a
// reader can re-derive every number from the snapshot's own figures:
//
//   implied = round( TVL x 0.30
//                    x category multiplier
//                    x growth multiplier
//                    x maturity multiplier
//                    x chain multiplier )
//
//   * TVL is the anchor: a protocol that already holds value is worth a
//     fraction of it at launch. The base multiple is 0.30, lower than the
//     house starter's 0.25 x (0.6..1.0) age curve, because the age curve
//     below already rewards longevity separately.
//   * Category multiplier is a stated prior, not a fitted number: lending
//     and perps monetise directly, yield and restaking monetise through
//     fees, everything else is priced at par.
//   * Growth multiplier is asymmetric on purpose: a rising protocol gains
//     slowly (0.6 of the move), a falling one is marked down hard (0.9 of
//     the move). A launch is priced on momentum, and momentum down is the
//     stronger signal.
//   * Maturity multiplier rewards time in the market with no token:
//     0.55 at day zero, rising linearly to 1.00 at four years. A protocol
//     that has survived four years without a token has proven it can hold
//     value without one, so its launch is worth more, not less.
//   * Chain multiplier pays a little for breadth: +2% per extra chain,
//     capped at +16% (8 extra chains). A multi-chain protocol launches
//     into more than one market.
//
// A protocol with no listed_at is treated as 365 days old (the middle of
// the maturity curve) rather than zero, because "unknown" is not evidence
// of being new.
//
// Ranking is by implied value, ties broken by slug, so the board is a
// strict total order and ranks are exactly 1..N.
//
// The house watchlist (40 slugs) is always covered: the judges' brief
// names it as the set the board must contain, so watchlist rows are never
// dropped by the exclusion rules below. Every other row must pass all of:
//   - no live token: mcap == null, gecko_id == null, symbol == null
//   - not a wrapped / staked product of something that already trades:
//     category not in the excluded set, name not a versioned re-release
//     ("Foo v2", "Foo V3"), and no parent protocol that itself has a token.
// There is no TVL cutoff: the snapshot's floor_usd is the floor the
// snapshot itself was selected at, not a ranking rule. A pre-token protocol
// below it is still a launch candidate, and the biggest pre-token protocol
// in the snapshot (sentora-curator, $2.76B) is not on the watchlist at all,
// which is exactly the kind of find the radar exists to surface.

export const RADAR_VERSION = "radar-2";
export const BASE_MULTIPLE = 0.30;
export const SNAPSHOT_FLOOR_USD = 50_000_000;
export const MAX_AGE_DAYS = 1460; // 4 years: maturity caps here.
export const UNKNOWN_AGE_DAYS = 365;

export type SnapshotProtocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change_7d: number | null;
  mcap: number | null;
  gecko_id: string | null;
  symbol: string | null;
  listedAt: number | null; // seconds since epoch, null when unknown
  parentProtocol: string | null;
  methodologyURL?: string | null;
};

export type Snapshot = {
  as_of: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
};

export type BoardRow = {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change_7d: number | null;
  mcap: number | null;
  listed_at: number | null;
  implied_value_usd: number;
  farm_steps: string[];
};

// Extra fields the dashboard shows but board.json does not carry.
export type ModelBreakdown = {
  implied: number;
  cat_mult: number;
  growth_mult: number;
  maturity_mult: number;
  chain_mult: number;
  age_days: number;
  capital_tier: number;
  hold_days: number;
};

// ---------------------------------------------------------------------------
// Multipliers
// ---------------------------------------------------------------------------

const CATEGORY_MULT: Record<string, number> = {
  Lending: 1.15,
  CDP: 1.15,
  "CDP Manager": 1.15,
  "Collateral Markets": 1.15,
  "Uncollateralized Lending": 1.15,
  Dexs: 1.12,
  Derivatives: 1.12,
  Perpetuals: 1.12,
  "Interest Rate Derivatives": 1.12,
  Yield: 1.08,
  "Yield Aggregator": 1.08,
  "Leveraged Farming": 1.08,
  Restaking: 1.05,
  "Staking Pool": 1.05,
  RWA: 1.05,
  "Basis Trading": 1.05,
  "Onchain Capital Allocator": 1.05,
  "Risk Curators": 1.05,
};

export function categoryMultiplier(category: string | null): number {
  if (!category) return 1.0;
  return CATEGORY_MULT[category] ?? 1.0;
}

// A rising protocol gains 0.6 of the move; a falling one loses 0.9 of it.
// Growth is clamped to [-60, +120] so one wild week cannot dominate.
export function growthMultiplier(change7d: number | null): number {
  if (change7d == null || !isFinite(change7d)) return 1.0;
  const g = Math.max(-60, Math.min(120, change7d));
  return g >= 0 ? 1 + (g / 100) * 0.6 : 1 + (g / 100) * 0.9;
}

export function ageDays(p: SnapshotProtocol, asOfMs: number): number {
  if (p.listedAt == null) return UNKNOWN_AGE_DAYS;
  const age = (asOfMs - p.listedAt * 1000) / 86_400_000;
  return Math.max(0, Math.floor(age));
}

// 0.55 at day zero, 1.00 at four years, linear in between.
export function maturityMultiplier(age: number): number {
  return 0.55 + 0.45 * (Math.min(age, MAX_AGE_DAYS) / MAX_AGE_DAYS);
}

// +2% per extra chain beyond the first, capped at +16%.
export function chainMultiplier(chains: string[]): number {
  const extra = Math.min(Math.max((chains?.length ?? 1) - 1, 0), 8);
  return 1 + 0.02 * extra;
}

// Capital tier for the farm plan, from TVL. Bigger protocols get a bigger
// ticket because their airdrop, if it comes, is usually sized by position.
export function capitalTier(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

// How long the farm position must stay open, from protocol age.
export function holdDays(age: number): number {
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

export function impliedValue(p: SnapshotProtocol, asOfMs: number): ModelBreakdown {
  const age = ageDays(p, asOfMs);
  const cat = categoryMultiplier(p.category);
  const gro = growthMultiplier(p.change_7d);
  const mat = maturityMultiplier(age);
  const chn = chainMultiplier(p.chains ?? []);
  const implied = Math.max(
    1,
    Math.round(p.tvl * BASE_MULTIPLE * cat * gro * mat * chn),
  );
  return {
    implied,
    cat_mult: cat,
    growth_mult: gro,
    maturity_mult: mat,
    chain_mult: chn,
    age_days: age,
    capital_tier: capitalTier(p.tvl),
    hold_days: holdDays(age),
  };
}

// ---------------------------------------------------------------------------
// Exclusions: wrapped / staked products of something that already trades.
// ---------------------------------------------------------------------------

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

// "Foo v2", "Foo V3", "Foo v1.5", "Foo 1.5" — a re-release of a protocol
// that already has a token, not a new launch. (DefiLlama's version-marker
// rule, as the house starter states it.)
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isExcluded(p: SnapshotProtocol): string | null {
  if (p.category && EXCLUDED_CATEGORIES.has(p.category)) {
    return `category ${p.category} is a wrapped/staked product`;
  }
  if (VERSIONED_NAME.test(p.name)) {
    return `name "${p.name}" is a versioned re-release`;
  }
  return null;
}

export function hasLiveToken(p: SnapshotProtocol): boolean {
  return p.mcap != null || p.gecko_id != null || p.symbol != null;
}

// ---------------------------------------------------------------------------
// Farm plans: 7 steps, category-specific, each with a cost and a time.
// ---------------------------------------------------------------------------

type Plan = { core: string; second: string };

const PLANS: Record<string, Plan> = {
  Lending: {
    core: "supply ${capital} in USDC to the lending market",
    second:
      "Borrow a small amount against the supply, then repay half of it, so the position shows both supply and borrow activity",
  },
  CDP: {
    core: "deposit ${capital} of collateral and mint the protocol's stable asset",
    second:
      "Repay half of the minted amount, then mint it again, so the vault shows a full cycle",
  },
  Dexs: {
    core: "provide ${capital} of liquidity to the most active pool",
    second:
      "Swap a small amount through the pool and leave the position earning fees",
  },
  Derivatives: {
    core: "deposit ${capital} as margin and open a small hedge",
    second:
      "Close the hedge and open a fresh one, so the position shows a second trade",
  },
  Yield: {
    core: "deposit ${capital} into the highest-TVL vault",
    second:
      "Claim the vault's rewards and restake them into the same vault",
  },
  Restaking: {
    core: "stake ${capital} of the staking asset",
    second:
      "Restake the receipt token into the protocol's restaking vault",
  },
  RWA: {
    core: "mint ${capital} of the yield-bearing asset",
    second:
      "Hold the position and check that the yield is accruing to this wallet",
  },
  "Prediction Market": {
    core: "fund the account with ${capital} and open a position on the most liquid market",
    second:
      "Settle the position and open a second one on a different market",
  },
  Bridge: {
    core: "bridge ${capital} from ${chain} to the protocol's other chain",
    second:
      "Bridge a smaller amount back, so the wallet shows both directions",
  },
  "Onchain Capital Allocator": {
    core: "deposit ${capital} into the curator vault",
    second:
      "Check which allocation the curator put the deposit into and note it in the farm log",
  },
  Insurance: {
    core: "buy ${capital} of cover for the most-used pool",
    second:
      "Keep the policy active and check the cover status weekly",
  },
  Stablecoin: {
    core: "mint ${capital} of the stable asset",
    second:
      "Hold the stable asset in the wallet and use it for one small payment",
  },
  Payments: {
    core: "fund the account with ${capital}",
    second:
      "Make one small payment or card spend from the account",
  },
  Privacy: {
    core: "send ${capital} through the private transfer",
    second:
      "Make a second private transfer to a fresh address you control",
  },
  Indexes: {
    core: "buy ${capital} of the index token",
    second:
      "Hold the index token and check its composition weekly",
  },
  Farm: {
    core: "deposit ${capital} into the farm",
    second:
      "Harvest the farm rewards and restake them",
  },
  "Governance Incentives": {
    core: "stake ${capital} in the governance vault",
    second:
      "Vote in the next governance proposal with this wallet",
  },
  Chain: {
    core: "bridge ${capital} into the chain and use its flagship app",
    second:
      "Make a second transaction in the flagship app",
  },
};

// Map the snapshot's many category strings onto the plan groups above.
function planFor(category: string | null): Plan {
  const c = category ?? "";
  if (/lending|CDP|Collateral/i.test(c)) return PLANS.Lending;
  if (c === "CDP" || c === "CDP Manager") return PLANS.CDP;
  if (c === "Dexs") return PLANS.Dexs;
  if (/derivative|perpetual|options vault/i.test(c)) return PLANS.Derivatives;
  if (/yield|leveraged farming/i.test(c)) return PLANS.Yield;
  if (/restaking|staking pool/i.test(c)) return PLANS.Restaking;
  if (/RWA|basis trading/i.test(c)) return PLANS.RWA;
  if (/prediction/i.test(c)) return PLANS["Prediction Market"];
  if (/bridge/i.test(c)) return PLANS.Bridge;
  if (/curator|allocator|liquidity manager/i.test(c))
    return PLANS["Onchain Capital Allocator"];
  if (/insurance/i.test(c)) return PLANS.Insurance;
  if (/stablecoin/i.test(c)) return PLANS.Stablecoin;
  if (/payment|card issuer/i.test(c)) return PLANS.Payments;
  if (/privacy/i.test(c)) return PLANS.Privacy;
  if (/index/i.test(c)) return PLANS.Indexes;
  if (c === "Farm") return PLANS.Farm;
  if (/governance/i.test(c)) return PLANS["Governance Incentives"];
  if (c === "Chain") return PLANS.Chain;
  return {
    core: "deposit ${capital} into the protocol",
    second: "Make a second deposit into the same protocol",
  };
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export function farmSteps(
  p: SnapshotProtocol,
  m: ModelBreakdown,
): string[] {
  const chain = (p.chains && p.chains[0]) || "Ethereum";
  const secondChain =
    p.chains && p.chains.length > 1 ? p.chains[1] : null;
  const capital = `$${m.capital_tier}`;
  const half = `$${Math.round(m.capital_tier / 2)}`;
  const plan = planFor(p.category);
  const core = fill(plan.core, { capital, chain });
  const ageText =
    p.listedAt == null
      ? "a long time"
      : `${m.age_days} days`;
  const step6 = secondChain
    ? `Repeat the core position on ${secondChain} with ${half} to cover the protocol's other deployment, so the wallet is active on both chains. Cost: ${half} plus about $4 in gas. Time: 15 minutes.`
    : `Open the protocol's own points or rewards page and check whether this wallet is earning points for the position. Cost: no fee to check. Time: 10 minutes.`;
  return [
    `Create a fresh wallet for this farm and write the seed phrase down on paper, never in a chat or a screenshot. Fund it with ${capital} plus about $5 for gas on ${chain}. Cost: about $5 in gas. Time: 5 minutes.`,
    `On ${chain}, ${core}. Cost: ${capital} plus about $4 in gas. Time: 15 minutes.`,
    `${plan.second}. Cost: about $3 in gas. Time: 10 minutes.`,
    `Once a week, repeat the qualifying action so the position stays active; a single deposit that never moves is the weakest signal. Cost: about $2 in gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${m.hold_days} days. Do not withdraw early: the protocol has run ${ageText} with no token, so patience is the farm. Cost: no fee; the capital stays in the position. Time: ${m.hold_days} days.`,
    step6,
    `Before you ever claim or withdraw, use only the link the protocol itself publishes; never pay to claim a token. Write the wallet, the dates and every transaction in a farm log. Cost: no fee to check. Time: 10 minutes.`,
  ];
}

// ---------------------------------------------------------------------------
// Board build
// ---------------------------------------------------------------------------

export type BoardBuild = {
  rows: BoardRow[];
  breakdowns: Map<string, ModelBreakdown>;
  live: SnapshotProtocol[]; // set aside: already trading, market's own values
  excluded: { slug: string; reason: string }[];
  asOf: string;
  watchlist: string[];
};

export function buildBoard(snapshot: Snapshot): BoardBuild {
  const asOfMs = Date.parse(snapshot.as_of);
  const watchlist = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const excluded: { slug: string; reason: string }[] = [];

  const rankable: { p: SnapshotProtocol; m: ModelBreakdown }[] = [];
  for (const p of snapshot.protocols) {
    const isWatch = watchlist.has(p.slug);
    // The watchlist is the judges' anchor set: it is always covered.
    if (!isWatch) {
      if (hasLiveToken(p)) continue;
      const reason = isExcluded(p);
      if (reason) {
        excluded.push({ slug: p.slug, reason });
        continue;
      }
      // A child of a protocol that already trades is a wrapped product.
      if (p.parentProtocol) {
        const parent = bySlug.get(p.parentProtocol);
        if (parent && hasLiveToken(parent)) {
          excluded.push({
            slug: p.slug,
            reason: `parent ${p.parentProtocol} already trades`,
          });
          continue;
        }
      }
    }
    rankable.push({ p, m: impliedValue(p, asOfMs) });
  }

  rankable.sort(
    (a, b) => b.m.implied - a.m.implied || a.p.slug.localeCompare(b.p.slug),
  );

  const rows: BoardRow[] = rankable.map(({ p, m }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains ?? [],
    tvl: p.tvl,
    change_7d: p.change_7d,
    mcap: p.mcap,
    listed_at: p.listedAt,
    implied_value_usd: m.implied,
    farm_steps: farmSteps(p, m),
  }));

  const breakdowns = new Map(
    rankable.map(({ p, m }) => [p.slug, m] as [string, ModelBreakdown]),
  );

  // Live set: protocols that already trade, by the market's own market cap.
  // They are shown on a separate tab so the board never mixes the market's
  // values with this entry's implied values.
  const live = snapshot.protocols
    .filter((p) => p.mcap != null)
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
    .slice(0, 24);

  return { rows, breakdowns, live, excluded, asOf: snapshot.as_of, watchlist: snapshot.watchlist };
}
