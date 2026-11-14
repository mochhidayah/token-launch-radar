// main.ts — Token Launch Radar entry (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every pre-token protocol with the radar-2 model in lib/model.ts,
// writes the ranked board to /output/board.json, and copies this repo's
// dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBoard,
  RADAR_VERSION,
  type BoardRow,
  type Snapshot,
  type SnapshotProtocol,
} from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined
    ? fallback
    : withEquals.slice(name.length + 3);
}

const inputArg = arg("input", "/input");
const inputFile = inputArg.endsWith(".json")
  ? inputArg
  : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2);
}
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

// ---------------------------------------------------------------------------
// Snapshot parsing: the sealed file is the only input. Anything missing or
// the wrong shape is a hard failure, never a silent default.
// ---------------------------------------------------------------------------

function asNumber(v: unknown, what: string): number | null {
  if (v == null) return null;
  if (typeof v === "number" && isFinite(v)) return v;
  throw new Error(`snapshot: ${what} is not a number: ${JSON.stringify(v)}`);
}

function asString(v: unknown, what: string): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  throw new Error(`snapshot: ${what} is not a string: ${JSON.stringify(v)}`);
}

function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("snapshot: not an object");
  const asOf = raw.as_of;
  if (typeof asOf !== "string" || !asOf) throw new Error("snapshot: as_of missing");
  const floor = raw.floor_usd;
  if (typeof floor !== "number") throw new Error("snapshot: floor_usd missing");
  if (!Array.isArray(raw.protocols)) throw new Error("snapshot: protocols missing");
  if (!Array.isArray(raw.watchlist)) throw new Error("snapshot: watchlist missing");
  const protocols: SnapshotProtocol[] = raw.protocols.map((r, i) => {
    const p = r as Record<string, unknown>;
    if (typeof p.slug !== "string" || !p.slug)
      throw new Error(`snapshot: protocols[${i}].slug missing`);
    // The sealed snapshot's field names: tvl_usd, mcap_usd, and listed_at as
    // an ISO date string ("2026-05-25"), not a Unix timestamp.
    let listedAt: number | null = null;
    if (typeof p.listed_at === "string" && p.listed_at) {
      const ms = Date.parse(p.listed_at);
      if (!isFinite(ms)) throw new Error(`snapshot: protocols[${i}].listed_at is not a date: ${p.listed_at}`);
      listedAt = Math.floor(ms / 1000);
    } else if (typeof p.listed_at === "number" && isFinite(p.listed_at)) {
      listedAt = p.listed_at;
    }
    return {
      slug: p.slug,
      name: typeof p.name === "string" ? p.name : p.slug,
      category: asString(p.category, `protocols[${i}].category`),
      chains: Array.isArray(p.chains)
        ? (p.chains as unknown[]).filter((c) => typeof c === "string")
        : [],
      tvl: asNumber(p.tvl_usd, `protocols[${i}].tvl_usd`) ?? 0,
      change_7d: asNumber(p.change_7d, `protocols[${i}].change_7d`),
      mcap: asNumber(p.mcap_usd, `protocols[${i}].mcap_usd`),
      gecko_id: asString(p.gecko_id, `protocols[${i}].gecko_id`),
      symbol: asString(p.symbol, `protocols[${i}].symbol`),
      listedAt,
      parentProtocol: asString(p.parentProtocol, `protocols[${i}].parentProtocol`),
      methodologyURL: asString(p.methodologyURL, `protocols[${i}].methodologyURL`),
    };
  });
  return {
    as_of: asOf,
    floor_usd: floor,
    protocols,
    watchlist: (raw.watchlist as unknown[]).filter(
      (w) => typeof w === "string",
    ) as string[],
  };
}

const snapshot = parseSnapshot(readFileSync(inputFile, "utf8"));

// ---------------------------------------------------------------------------
// Self-check: the board must pass the gate's own rules before anything is
// written. A board the gate refuses is a bug in the model, not a submission.
// ---------------------------------------------------------------------------

function boardIssue(rows: BoardRow[], snap: Snapshot): string | null {
  if (rows.length < 100)
    return `board has ${rows.length} rows, the gate needs at least 100`;
  const watch = new Set(snap.watchlist);
  for (const row of rows) watch.delete(row.slug);
  if (watch.size > 0)
    return `board misses watchlist slugs: ${[...watch].join(", ")}`;
  let prev: number | null = null;
  let allEqual = true;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.rank !== i + 1) return `row ${i} has rank ${row.rank}, expected ${i + 1}`;
    const v = row.implied_value_usd;
    if (!Number.isInteger(v) || v <= 0 || v > 1e14)
      return `row ${row.slug}: implied value ${v} is not a positive integer <= 1e14`;
    if (prev !== null) {
      if (v > prev) return `row ${row.slug}: implied value rises (${v} > ${prev})`;
      if (v !== prev) allEqual = false;
    }
    prev = v;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12)
      return `row ${row.slug}: ${row.farm_steps?.length} farm steps, the gate needs 3-12`;
    for (const step of row.farm_steps) {
      if (typeof step !== "string" || step.length < 20 || step.length > 600)
        return `row ${row.slug}: a farm step is ${step?.length} chars, the gate needs 20-600`;
    }
  }
  if (allEqual) return "every implied value is the same";
  return null;
}

const { rows, breakdowns, live, excluded, asOf, watchlist } =
  buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), `${JSON.stringify({ rows })}\n`);

// data.js carries the same board plus the model breakdown and the live set
// the dashboard needs. It is the only file the page loads.
const dataRows = rows.map((row) => {
  const m = breakdowns.get(row.slug)!;
  return {
    ...row,
    cat_mult: m.cat_mult,
    growth_mult: m.growth_mult,
    maturity_mult: m.maturity_mult,
    chain_mult: m.chain_mult,
    age_days: m.age_days,
  };
});
const liveRows = live.map((p) => ({
  slug: p.slug,
  name: p.name,
  category: p.category,
  chains: p.chains ?? [],
  tvl: p.tvl,
  change_7d: p.change_7d,
  mcap: p.mcap,
  listed_at: p.listedAt,
}));
const dataScript =
  `// Generated by main.ts from the sealed snapshot. Do not edit by hand.\n` +
  `window.RADAR = ${JSON.stringify(
    {
      version: RADAR_VERSION,
      as_of: asOf,
      floor_usd: snapshot.floor_usd,
      watchlist,
      rows: dataRows,
      live: liveRows,
      excluded_count: excluded.length,
    },
    null,
    0,
  )};\n`;
writeFileSync(join(out, "data.js"), dataScript);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyFiles(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyFiles(join(here, "screenshots"), join(out, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(
    `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view\n`,
  );
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(
      `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
    );
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, "dossier.json"),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const watchRows = rows.filter((r) => watchlist.includes(r.slug)).length;
const earlyRows = rows.length - watchRows;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${watchlist.length} on the watchlist, ${rows.length} rows scored (${watchRows} watchlist, ${earlyRows} early, ${live.length} live set aside, ${excluded.length} excluded as wrapped/staked)\n` +
    `token radar: top 3 by implied value: ${rows
      .slice(0, 3)
      .map((r) => `${r.slug} $${r.implied_value_usd.toLocaleString("en-US")}`)
      .join(", ")}\n` +
    `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")} (${dash.length} files), ${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")}\n`,
);
