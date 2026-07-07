/**
 * lib/formatters.ts
 * Professional financial number formatting utilities.
 *
 * Design goal: ZERO raw machine values ever reach the UI.
 * Every value that comes from the API — no matter its form —
 * is normalised here before display.
 *
 * Exported surface:
 *   formatLargeNumber()   — $4.72T / $125B / $5.3B / $875M / $430K
 *   formatMarketCap()     — alias of formatLargeNumber with $ prefix
 *   formatCurrency()      — same as formatMarketCap
 *   formatPercentage()    — 0.272 → 27.2% | 15.8 → 15.8% | "15.8%" → 15.8%
 *   formatRatio()         — 29.84 → 29.8x  (P/E, EV/EBITDA, etc.)
 *   formatDebtEquity()    — 0.73 → 0.73    (plain decimal, 2dp)
 *   formatMetricValue()   — smart dispatcher used by MetricsTable
 *   formatLabel()         — camelCase → Title Case
 *
 * Non-formatting helpers (unchanged):
 *   getRecommendationLevel()
 *   confidenceToScore()
 *   derivePortfolioScores()
 *   deriveFairValue()
 *   extractSources()
 */

/* ─── Internal helpers ──────────────────────────────────────── */

/**
 * Strips everything that isn't a digit, dot, minus or e/E
 * and returns the parsed float (or NaN).
 */
function parseNumeric(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === "" || raw === "N/A" || raw === "-") {
    return NaN;
  }
  if (typeof raw === "number") return raw;
  // Remove currency symbols, commas, spaces, trailing letters (except e for sci notation)
  const cleaned = String(raw)
    .trim()
    .replace(/[$,\s]/g, "")
    .replace(/%$/, ""); // strip trailing % — caller decides what to do with it
  return parseFloat(cleaned);
}

/**
 * Returns true if the raw string already has a trailing %.
 */
function isAlreadyPercent(raw: string | number | undefined): boolean {
  return typeof raw === "string" && raw.trim().endsWith("%");
}

/**
 * Returns true if the raw string already has a trailing x (ratio).
 */
function isAlreadyRatio(raw: string | number | undefined): boolean {
  return typeof raw === "string" && /^\d[\d.]*x$/i.test(raw.trim());
}

/**
 * Abbreviates a large absolute number into K / M / B / T with clean precision.
 *
 * Precision rules (matching Bloomberg / Yahoo Finance style):
 *   T: 2 decimal places when < 10T, else 1
 *   B: 2 decimal places when < 10B, else 1 (drop trailing zero)
 *   M: whole number when >= 100M, 1dp otherwise
 *   K: whole number
 */
function abbreviate(n: number, prefix = ""): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  if (abs >= 1e12) {
    const val = abs / 1e12;
    return `${sign}${prefix}${val >= 10 ? val.toFixed(1) : val.toFixed(2)}T`;
  }
  if (abs >= 1e9) {
    const val = abs / 1e9;
    // 125.00 → 125B, 5.20 → 5.2B, 4.72 → 4.72B
    let str: string;
    if (val >= 100) str = val.toFixed(0);
    else if (val >= 10) str = val.toFixed(1).replace(/\.0$/, "");
    else str = val.toFixed(2).replace(/\.?0+$/, "");
    return `${sign}${prefix}${str}B`;
  }
  if (abs >= 1e6) {
    const val = abs / 1e6;
    const str = val >= 100 ? val.toFixed(0) : val.toFixed(1).replace(/\.?0+$/, "");
    return `${sign}${prefix}${str}M`;
  }
  if (abs >= 1e3) {
    return `${sign}${prefix}${(abs / 1e3).toFixed(0)}K`;
  }
  // Below 1K — just show with 2dp
  return `${sign}${prefix}${abs.toFixed(2)}`;
}

/* ─── Public formatting functions ───────────────────────────── */

/**
 * formatLargeNumber
 * Converts any large numeric value to K/M/B/T abbreviation.
 * Does NOT add a $ prefix — use formatMarketCap/formatCurrency for that.
 *
 * Examples:
 *   4718977352000 → "4.72T"
 *   125000000000  → "125B"
 *   5300000000    → "5.3B"
 *   875000000     → "875M"
 *   430000        → "430K"
 */
export function formatLargeNumber(raw: string | number | undefined): string {
  const n = parseNumeric(raw);
  if (isNaN(n)) return "N/A";
  return abbreviate(n);
}

/**
 * formatMarketCap / formatCurrency
 * Same as formatLargeNumber but adds a $ prefix.
 *
 * Examples:
 *   4718977352000 → "$4.72T"
 *   125000000000  → "$125B"
 *   875000000     → "$875M"
 */
export function formatMarketCap(raw: string | number | undefined): string {
  // If the raw value already looks like "$4.72T" pass through
  if (typeof raw === "string" && /^\$[\d.]+[KMBT]$/.test(raw.trim())) return raw.trim();

  const n = parseNumeric(raw);
  if (isNaN(n)) return "N/A";
  return abbreviate(n, "$");
}

export const formatCurrency = formatMarketCap;

/**
 * formatPercentage
 * Converts decimal ratios or whole-number percents into a clean "XX.X%" string.
 *
 * Detection logic:
 *   - If string already ends with "%" → strip and re-format to ensure consistent dp
 *   - If |n| < 2  → treat as decimal ratio (e.g. 0.85 → 85%)
 *   - If |n| >= 2 → treat as already-percent (e.g. 15.8 → 15.8%)
 *
 * Examples:
 *   0.272  → "27.2%"
 *   0.0395 → "3.95%"
 *   0.85   → "85.0%"
 *   15.8   → "15.8%"
 *   "15.8%" → "15.8%"
 *   100    → "100.0%"  (revenue growth 100%)
 */
export function formatPercentage(raw: string | number | undefined): string {
  if (raw === undefined || raw === null || raw === "" || raw === "N/A" || raw === "-") {
    return "N/A";
  }

  let wasPercent = false;
  let n: number;

  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.endsWith("%")) {
      wasPercent = true;
      n = parseFloat(s.slice(0, -1).replace(/,/g, ""));
    } else {
      n = parseFloat(s.replace(/[$,]/g, ""));
    }
  } else {
    n = raw;
  }

  if (isNaN(n)) return String(raw);

  if (wasPercent) {
    return `${n.toFixed(1)}%`;
  }

  const percentage = n <= 1 ? n * 100 : n;
  return `${percentage.toFixed(1)}%`;
}

/**
 * formatRatio
 * Formats P/E, EV/EBITDA, PEG etc. as "NNNx"
 *
 * Examples:
 *   29.84 → "29.8x"
 *   5.0   → "5.0x"
 *   "25x" → "25.0x"
 */
export function formatRatio(raw: string | number | undefined): string {
  if (raw === undefined || raw === null || raw === "" || raw === "N/A" || raw === "-") {
    return "N/A";
  }
  if (isAlreadyRatio(raw)) {
    // Already "29.8x" — normalise to 1dp
    const n = parseFloat(String(raw));
    return isNaN(n) ? String(raw) : `${n.toFixed(1)}x`;
  }
  const n = parseNumeric(raw);
  if (isNaN(n)) return String(raw);
  if (n <= 0) return "N/A"; // Negative P/E is meaningless to display
  return `${n.toFixed(1)}x`;
}

/**
 * formatDebtEquity
 * Debt-to-Equity shown as a plain decimal (2dp), no x suffix.
 *
 * Examples:
 *   0.73  → "0.73"
 *   1.5   → "1.50"
 */
export function formatDebtEquity(raw: string | number | undefined): string {
  const n = parseNumeric(raw);
  if (isNaN(n)) return "N/A";
  return n.toFixed(2);
}

/**
 * formatMetricValue
 * Smart dispatcher — inspects the field key and routes to the
 * correct formatter. Used by MetricsTable where field types are
 * not known at compile time.
 *
 * Key detection order (most-specific first):
 *   1. debt / equity            → formatDebtEquity
 *   2. pe / peg / ev / ratio    → formatRatio
 *   3. marketcap / revenue /
 *      cash / earnings / fcf /
 *      ebitda / income / profit
 *      (when value looks large)  → formatMarketCap
 *   4. margin / growth / yield /
 *      roe / roa / return /
 *      profit (small decimal)    → formatPercentage
 *   5. fallback: try large-number, else passthrough
 */
export function formatMetricValue(key: string, raw: string | undefined): string {
  if (!raw || raw.trim() === "" || raw === "N/A" || raw === "-") return "N/A";

  const lk = key.toLowerCase();
  const trimmed = raw.trim();

  // 1. Debt-to-Equity
  if (lk.includes("debt") || lk === "de" || lk === "d/e") {
    return formatDebtEquity(trimmed);
  }

  // 2. Ratio fields (P/E etc.)
  if (
    lk === "pe" ||
    lk === "peratio" ||
    lk.includes("priceto") ||
    lk.includes("priceearning") ||
    lk.includes("peg") ||
    lk.includes("ev/") ||
    (lk.includes("ratio") && !lk.includes("margin"))
  ) {
    return formatRatio(trimmed);
  }

  // 3. Already a percent string → clean it up
  if (isAlreadyPercent(trimmed)) {
    return formatPercentage(trimmed);
  }

  // 4. Already an x-ratio string
  if (isAlreadyRatio(trimmed)) {
    return formatRatio(trimmed);
  }

  // Parse once and branch
  const n = parseNumeric(trimmed);
  const absN = Math.abs(isNaN(n) ? 0 : n);

  // 5. Percent-type fields by key name
  if (
    lk.includes("margin") ||
    lk.includes("growth") ||
    lk.includes("yield") ||
    lk.includes("return") ||
    lk.includes("roe") ||
    lk.includes("roa") ||
    lk.includes("roic") ||
    lk.includes("payout")
  ) {
    return formatPercentage(n !== 0 ? n : trimmed);
  }

  // 6. Large monetary fields by key name
  if (
    lk.includes("marketcap") ||
    lk.includes("cash") ||
    lk.includes("ebitda") ||
    lk.includes("income") ||
    lk.includes("fcf") ||
    lk.includes("freecash") ||
    lk.includes("earnings") ||
    lk.includes("assets") ||
    lk.includes("equity")
  ) {
    if (!isNaN(n) && absN >= 1000) return formatMarketCap(n);
    // Small values for these keys are still currency
    if (!isNaN(n)) return formatMarketCap(n);
    return trimmed;
  }

  // 7. Unknown key — heuristic on value magnitude
  if (!isNaN(n)) {
    // Very large → money
    if (absN >= 1e6) return formatMarketCap(n);
    // Looks like a decimal ratio (0.00–1.99)
    if (absN < 2 && trimmed.includes(".")) return formatPercentage(n);
    // Looks like a P/E (2–200 range, no %)
    if (absN >= 2 && absN <= 200) return formatRatio(n);
    return trimmed;
  }

  return trimmed;
}

/**
 * formatLabel
 * camelCase / PascalCase key → readable Title Case label.
 *
 * Examples:
 *   "peRatio"       → "Pe Ratio"   (displayed as "P/E Ratio" via alias map below)
 *   "revenueGrowth" → "Revenue Growth"
 *   "marketCap"     → "Market Cap"
 */

const LABEL_ALIASES: Record<string, string> = {
  peratio:       "P/E Ratio",
  pe:            "P/E",
  peg:           "PEG Ratio",
  revenuegrowth: "Revenue Growth",
  revenuegrowthratio: "Revenue Growth",
  profitmargin:  "Profit Margin",
  grossmargin:   "Gross Margin",
  operatingmargin: "Operating Margin",
  netmargin:     "Net Margin",
  debttoequity:  "Debt / Equity",
  debtequity:    "Debt / Equity",
  roe:           "Return on Equity",
  roa:           "Return on Assets",
  roic:          "ROIC",
  freecashflow:  "Free Cash Flow",
  marketcap:     "Market Cap",
  earningsgrowth:"Earnings Growth",
  dividendyield: "Dividend Yield",
  pricebook:     "Price / Book",
};

export function formatLabel(key: string): string {
  const lk = key.toLowerCase().replace(/[^a-z]/g, "");
  if (LABEL_ALIASES[lk]) return LABEL_ALIASES[lk];

  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/* ─── Non-formatting helpers (logic unchanged) ───────────────── */

/**
 * Maps verdict + confidence → 0–4 recommendation scale index.
 * 0 = STRONG PASS … 4 = STRONG INVEST
 */
export function getRecommendationLevel(verdict: string, confidence: string): number {
  const v = verdict?.toUpperCase();
  const c = confidence?.toUpperCase();

  if (v === "INVEST") {
    if (c === "HIGH")   return 4;
    if (c === "MEDIUM") return 3;
    return 2;
  }
  if (v === "PASS") {
    if (c === "HIGH")   return 0;
    if (c === "MEDIUM") return 1;
    return 2;
  }
  return 2;
}

/**
 * Maps confidence label → 0–100 numeric score for the progress bar.
 */
export function confidenceToScore(confidence: string): number {
  const c = confidence?.toUpperCase();
  if (c === "HIGH")   return 82;
  if (c === "MEDIUM") return 58;
  if (c === "LOW")    return 34;
  return 50;
}

/**
 * Derives portfolio suitability scores (0–10) from AI analysis text.
 * Pure frontend — no extra API calls.
 */
export function derivePortfolioScores(
  verdict: string,
  confidence: string,
  reasoning?: {
    growthPotential?: string;
    financialHealth?: string;
    strengths?: string[];
    risks?: string[];
  },
  keyMetrics?: Record<string, string>
): Record<string, number> {
  const isInvest    = verdict?.toUpperCase() === "INVEST";
  const confScore   = confidenceToScore(confidence);

  const growthText    = (reasoning?.growthPotential || "").toLowerCase();
  const finText       = (reasoning?.financialHealth  || "").toLowerCase();
  const strengthsText = (reasoning?.strengths || []).join(" ").toLowerCase();

  const hasGrowth   = growthText.includes("grow") || growthText.includes("expand") || growthText.includes("opportunity");
  const hasValue    = finText.includes("underval") || finText.includes("cheap") || finText.includes("discount") || strengthsText.includes("underval");
  const hasDividend = finText.includes("dividend") || strengthsText.includes("dividend") || (keyMetrics?.dividendYield && keyMetrics.dividendYield !== "N/A");
  const hasMomentum = growthText.includes("accelerat") || growthText.includes("momentum") || growthText.includes("surge");
  const hasCompound = growthText.includes("long-term") || growthText.includes("decade") || strengthsText.includes("moat") || strengthsText.includes("compet");

  const base = isInvest ? Math.round(confScore / 10) : Math.round((100 - confScore) / 14);

  return {
    Growth:       clamp(base + (hasGrowth   ? 2 : -1), 1, 10),
    Value:        clamp(base + (hasValue    ? 3 : -2), 1, 10),
    Dividend:     clamp(base + (hasDividend ? 3 : -3), 1, 10),
    Momentum:     clamp(base + (hasMomentum ? 2 :  0), 1, 10),
    "Long-Term":  clamp(base + (hasCompound ? 2 :  0), 1, 10),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Derives a fair value estimate from available P/E + growth + margin data.
 */
export function deriveFairValue(
  keyMetrics?: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _highlights?: { marketCap?: string }
): { estimate: string; upside: string | null; method: string } | null {
  if (!keyMetrics) return null;

  const peRaw     = keyMetrics.peRatio || keyMetrics.pe;
  const marginRaw = keyMetrics.profitMargin;
  const growthRaw = keyMetrics.revenueGrowth;

  if (!peRaw || peRaw === "N/A") return null;

  const pe = parseNumeric(peRaw);
  if (isNaN(pe) || pe <= 0) return null;

  const growthRaw2 = parseNumeric(growthRaw);
  const marginRaw2 = parseNumeric(marginRaw);

  // Normalise: if growth looks like a decimal ratio, convert to %
  const growth = !isNaN(growthRaw2)
    ? (Math.abs(growthRaw2) < 2 ? growthRaw2 * 100 : growthRaw2)
    : 0;
  const margin = !isNaN(marginRaw2)
    ? (Math.abs(marginRaw2) < 2 ? marginRaw2 * 100 : marginRaw2)
    : 0;

  const growthAdj = growth > 10 ? growth * 0.5 : growth * 0.3;
  const marginAdj = margin > 15 ? 3 : 0;
  const fairPE    = Math.max(8, Math.min(60, 15 + growthAdj + marginAdj));

  const discount   = ((fairPE - pe) / pe) * 100;
  const upsideStr  = discount > 0
    ? `+${discount.toFixed(1)}% upside`
    : `${discount.toFixed(1)}% downside`;

  return {
    estimate: `~${fairPE.toFixed(1)}x fair P/E`,
    upside:   upsideStr,
    method:   `Based on current P/E (${pe.toFixed(1)}x) vs. estimated fair P/E derived from revenue growth (${growth.toFixed(1)}%) and profit margin (${margin.toFixed(1)}%)`,
  };
}

/**
 * Extracts research data sources from agent tool call history.
 */
export function extractSources(
  steps?: Array<{ tool: string; input: string; output: string }>
): Array<{ name: string; query: string; type: string }> {
  if (!steps) return [];

  const sources: Array<{ name: string; query: string; type: string }> = [];
  const seen = new Set<string>();

  for (const step of steps) {
    let parsed: Record<string, string> = {};
    try { parsed = JSON.parse(step.input); } catch { parsed = { query: step.input }; }

    const query = parsed.query || parsed.companyName || parsed.symbol || step.input;

    if (step.tool === "web_search" && !seen.has("web_" + query)) {
      seen.add("web_" + query);
      sources.push({ name: "Web Search", query, type: "web" });
    } else if (step.tool === "get_financial_data" && !seen.has("fin_" + query)) {
      seen.add("fin_" + query);
      sources.push({ name: "Alpha Vantage", query, type: "financial" });
    } else if (step.tool === "search_news" && !seen.has("news_" + query)) {
      seen.add("news_" + query);
      sources.push({ name: "News Search (Serper)", query, type: "news" });
    }
  }

  // Always show canonical sources
  if (!sources.find(s => s.name === "Alpha Vantage")) {
    sources.push({ name: "Alpha Vantage", query: "Financial fundamentals", type: "financial" });
  }
  if (!sources.find(s => s.name.includes("Serper"))) {
    sources.push({ name: "Google (Serper)", query: "Web & news search", type: "web" });
  }

  return sources;
}
