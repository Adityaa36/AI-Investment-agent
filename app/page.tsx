"use client";

import { useState, useEffect, useCallback } from "react";
import {
  formatLabel,
  formatMetricValue,
  formatMarketCap,
  formatPercentage,
  getRecommendationLevel,
  confidenceToScore,
  derivePortfolioScores,
  deriveFairValue,
  extractSources,
} from "@/lib/formatters";

/* ═══════════════════════════════════════════════════════
   Constants
═══════════════════════════════════════════════════════ */

const QUICK_TICKERS = [
  "Zomato", "Infosys", "Tesla", "Reliance Industries",
  "TCS", "Apple", "Microsoft", "HDFC Bank",
];

const LOADING_STEPS = [
  "Searching company information",
  "Fetching financial data",
  "Analyzing recent news",
  "Evaluating competitive position",
  "Generating investment verdict",
];

const REC_LABELS = [
  "STRONG PASS",
  "PASS",
  "HOLD",
  "INVEST",
  "STRONG INVEST",
] as const;

const REC_CLASS = [
  "active-strong-pass",
  "active-pass",
  "active-hold",
  "active-invest",
  "active-strong-invest",
] as const;

const METHODOLOGY_STEPS = [
  { title: "Web Search", desc: "Retrieves general company background, business model, and competitive landscape via Google Search API." },
  { title: "Financial Retrieval", desc: "Fetches real-time fundamentals — P/E ratio, revenue, margins, market cap — from Alpha Vantage." },
  { title: "News Analysis", desc: "Scans recent news for material events: earnings surprises, regulatory changes, management shifts." },
  { title: "Sentiment Analysis", desc: "Evaluates market sentiment from news tone, analyst commentary, and recent price action." },
  { title: "Risk Assessment", desc: "Identifies sector-specific, macro, and company-level risks that could impair investment thesis." },
  { title: "Investment Decision", desc: "AI synthesizes all signals into a structured recommendation with confidence scoring." },
];

/* ═══════════════════════════════════════════════════════
   Types  (unchanged from original API contract)
═══════════════════════════════════════════════════════ */

interface KeyMetrics { [key: string]: string; }

interface Reasoning {
  strengths?: string[];
  risks?: string[];
  financialHealth?: string;
  growthPotential?: string;
  competitivePosition?: string;
  recentDevelopments?: string;
  investmentCommittee?: string;
  whatWouldChangeOurView?: string[] | {
    upgradeTriggers?: string[];
    riskTriggers?: string[];
    improveTriggers?: string[];
    downgradeTriggers?: string[];
  };
}

interface ResearchStep { tool: string; input: string; output: string; }

interface Highlights {
  companyOverview?: string;
  sector?: string;
  marketCap?: string;
  stockTicker?: string;
}

interface ResearchResult {
  success: boolean;
  company: string;
  duration?: string;
  verdict: string;
  confidence: string;
  summary: string;
  highlights?: Highlights;
  reasoning?: Reasoning;
  keyMetrics?: KeyMetrics;
  analystNote?: string;
  researchSteps?: ResearchStep[];
  rawOutput?: string;
  error?: string;
}

type ViewMode = "invest" | "hold" | "pass";

interface ViewChangeTriggers {
  upgrade: string[];
  risk: string[];
}

/* ═══════════════════════════════════════════════════════
   Helper: clock
═══════════════════════════════════════════════════════ */

function getTS(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function getDate(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

/* ═══════════════════════════════════════════════════════
   Sub-components
═══════════════════════════════════════════════════════ */

/** Analyst recommendation scale — 5-step track */
function RecScale({ level }: { level: number }) {
  return (
    <div className="rec-scale">
      <div className="rec-scale-label">Analyst Recommendation</div>
      <div className="rec-track">
        {REC_LABELS.map((lbl, i) => (
          <div
            key={lbl}
            className={`rec-step ${i === level ? REC_CLASS[i] : ""}`}
          >
            {lbl}
          </div>
        ))}
      </div>
    </div>
  );
}

/** ── Confidence pill ── */
function ConfPill({ confidence }: { confidence: string }) {
  const score = confidenceToScore(confidence);
  const c     = confidence?.toUpperCase();
  const cls   = c === "HIGH" ? "high" : c === "MEDIUM" ? "medium" : "low";
  const label = c === "HIGH" ? "High" : c === "MEDIUM" ? "Medium" : "Low";
  // Format score as percentage string (e.g. 82%)
  const pctLabel = formatPercentage(score);
  return (
    <div className="conf-pill">
      <span className="conf-pill-lbl">Confidence</span>
      <div className="conf-bar-wrap">
        <div className="conf-track">
          <div className={`conf-fill ${cls}`} style={{ width: `${score}%` }} />
        </div>
        <span className="conf-pct">{label} · {pctLabel}</span>
      </div>
    </div>
  );
}

/** Key financial metrics as a horizontal table */
function MetricsTable({
  keyMetrics,
  marketCap,
}: {
  keyMetrics: KeyMetrics;
  marketCap?: string;
}) {
  const entries = Object.entries(keyMetrics);
  if (marketCap && marketCap !== "N/A") {
    entries.push(["marketCap", marketCap]);
  }

  // Helper to detect if a formatted value is positive or negative
  function valueClass(key: string, raw: any): string {
    if (raw === undefined || raw === null) return "";
    const lk = key.toLowerCase();
    const isPct =
      lk.includes("growth") || lk.includes("margin") || lk.includes("return");
    if (!isPct) return "";
    const str = String(raw);
    const n = parseFloat(str.replace(/[^0-9.-]/g, ""));
    if (isNaN(n)) return "";
    return n > 0 ? "positive" : n < 0 ? "negative" : "";
  }

  return (
    <div className="metrics-table-wrap">
      <table className="metrics-table">
        <thead>
          <tr>
            {entries.map(([key]) => (
              <th key={key}>{formatLabel(key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {entries.map(([key, raw]) => {
              const fmt = formatMetricValue(key, raw);
              return (
                <td key={key} className={valueClass(key, raw)}>
                  {fmt}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Bull Thesis / Bear Thesis two-column panel */
function BullBear({ reasoning }: { reasoning: Reasoning }) {
  return (
    <div className="bull-bear-grid">
      {/* Bull Thesis */}
      <div className="bb-panel">
        <div className="bb-header bull">
          <span className="bb-indicator green" />
          Bull Thesis
        </div>
        <ul className="bb-list bull">
          {(reasoning.strengths || []).length > 0
            ? reasoning.strengths!.map((s, i) => <li key={i}>{s}</li>)
            : <li style={{ color: "var(--t3)" }}>No data</li>}
        </ul>
      </div>

      {/* Bear Thesis */}
      <div className="bb-panel">
        <div className="bb-header bear">
          <span className="bb-indicator red" />
          Bear Thesis
        </div>
        <ul className="bb-list bear">
          {(reasoning.risks || []).length > 0
            ? reasoning.risks!.map((r, i) => <li key={i}>{r}</li>)
            : <li style={{ color: "var(--t3)" }}>No data</li>}
        </ul>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   Comparison components
═══════════════════════════════════════════════════════ */

/** Derive a numeric score for ranking verdicts */
function verdictScore(verdict: string, confidence: string): number {
  const v = verdict?.toUpperCase();
  const c = confidence?.toUpperCase();
  const base = v === "INVEST" ? 2 : v === "HOLD" ? 1 : 0;
  const boost = c === "HIGH" ? 0.9 : c === "MEDIUM" ? 0.5 : 0;
  return base + boost;
}

/** Determine winner or draw */
function pickWinner(
  a: ResearchResult,
  b: ResearchResult
): { winner: ResearchResult | null; reason: string } {
  const sa = verdictScore(a.verdict, a.confidence);
  const sb = verdictScore(b.verdict, b.confidence);
  if (Math.abs(sa - sb) < 0.5) {
    return { winner: null, reason: "Both companies are comparably rated by the AI research agent. Review the detailed metrics below to decide." };
  }
  const winner = sa > sb ? a : b;
  const loser  = sa > sb ? b : a;
  const wVerdict = winner.verdict?.toUpperCase();
  const lVerdict = loser.verdict?.toUpperCase();
  const reason = `${winner.company} (${wVerdict} · ${winner.confidence} confidence) scores higher than ${loser.company} (${lVerdict} · ${loser.confidence} confidence) based on the overall investment verdict and analyst confidence.`;
  return { winner, reason };
}

/** A compact per-company column inside the comparison grid */
function CmpCol({ result }: { result: ResearchResult }) {
  const vCls = result.verdict?.toUpperCase() === "INVEST" ? "invest" : result.verdict?.toUpperCase() === "HOLD" ? "hold" : "pass";
  const metrics = result.keyMetrics ?? {};
  const KEYS = ["peRatio", "profitMargin", "revenueGrowth", "debtToEquity", "roe", "freeCashFlow"];

  function valCls(key: string, raw: any): string {
    if (raw === undefined || raw === null) return "";
    const lk = key.toLowerCase();
    if (!lk.includes("growth") && !lk.includes("margin") && !lk.includes("return") && !lk.includes("roe")) return "";
    const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ""));
    if (isNaN(n)) return "";
    return n > 0 ? "positive" : n < 0 ? "negative" : "";
  }

  return (
    <div className="cmp-col">
      <div className="cmp-col-header">
        <div>
          <div className="cmp-col-name">{result.company}</div>
          <div className="cmp-col-meta">
            {result.highlights?.stockTicker && <span>{result.highlights.stockTicker}</span>}
            {result.highlights?.sector && <span>{result.highlights.sector}</span>}
            {result.highlights?.marketCap && <span>Mkt Cap: {formatMarketCap(result.highlights.marketCap)}</span>}
          </div>
        </div>
        <span className={`cmp-verdict-pill ${vCls}`}>{result.verdict}</span>
      </div>

      <p className="cmp-summary-text">{result.summary}</p>

      <table className="cmp-metrics-table">
        <tbody>
          {KEYS.filter(k => metrics[k] !== undefined).map(k => (
            <tr key={k}>
              <td className="cmp-metric-key">{formatLabel(k)}</td>
              <td className={`cmp-metric-val ${valCls(k, metrics[k])}`}>
                {formatMetricValue(k, metrics[k])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Head-to-head metric comparison table */
function H2HTable({ a, b }: { a: ResearchResult; b: ResearchResult }) {
  const ROWS: { label: string; key: string; higherIsBetter: boolean }[] = [
    { label: "Verdict",        key: "__verdict",      higherIsBetter: true },
    { label: "Confidence",     key: "__confidence",   higherIsBetter: true },
    { label: "P/E Ratio",      key: "peRatio",        higherIsBetter: false },
    { label: "Profit Margin",  key: "profitMargin",   higherIsBetter: true  },
    { label: "Revenue Growth", key: "revenueGrowth",  higherIsBetter: true  },
    { label: "Debt / Equity",  key: "debtToEquity",   higherIsBetter: false },
    { label: "ROE",            key: "roe",            higherIsBetter: true  },
  ];

  const safeNum = (v: any) => { const n = parseFloat(String(v).replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };

  function getCells(row: typeof ROWS[0]) {
    if (row.key === "__verdict") {
      const sa = verdictScore(a.verdict, a.confidence);
      const sb = verdictScore(b.verdict, b.confidence);
      const aWin = sa > sb + 0.4; const bWin = sb > sa + 0.4;
      return {
        aFmt: a.verdict, bFmt: b.verdict,
        aCls: aWin ? "winner-cell" : bWin ? "loser-cell" : "tie-cell",
        bCls: bWin ? "winner-cell" : aWin ? "loser-cell" : "tie-cell",
      };
    }
    if (row.key === "__confidence") {
      const order = ["LOW", "MEDIUM", "HIGH"];
      const ia = order.indexOf(a.confidence?.toUpperCase()); const ib = order.indexOf(b.confidence?.toUpperCase());
      const aWin = ia > ib; const bWin = ib > ia;
      return {
        aFmt: a.confidence, bFmt: b.confidence,
        aCls: aWin ? "winner-cell" : bWin ? "loser-cell" : "tie-cell",
        bCls: bWin ? "winner-cell" : aWin ? "loser-cell" : "tie-cell",
      };
    }
    const aRaw = (a.keyMetrics ?? {})[row.key]; const bRaw = (b.keyMetrics ?? {})[row.key];
    const aFmt = formatMetricValue(row.key, aRaw); const bFmt = formatMetricValue(row.key, bRaw);
    const aN = safeNum(aRaw); const bN = safeNum(bRaw);
    if (aN === null || bN === null) return { aFmt, bFmt, aCls: "", bCls: "" };
    const aWins = row.higherIsBetter ? aN > bN : aN < bN;
    const bWins = row.higherIsBetter ? bN > aN : bN < aN;
    return {
      aFmt, bFmt,
      aCls: aWins ? "winner-cell" : bWins ? "loser-cell" : "tie-cell",
      bCls: bWins ? "winner-cell" : aWins ? "loser-cell" : "tie-cell",
    };
  }

  return (
    <div className="h2h-card">
      <div className="h2h-title">Head-to-Head Metrics</div>
      <table className="h2h-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>{a.company}</th>
            <th>{b.company}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => {
            const { aFmt, bFmt, aCls, bCls } = getCells(row);
            return (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className={aCls}>{aFmt}</td>
                <td className={bCls}>{bFmt}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Full comparison report */
function ComparisonView({
  a, b,
  onReset,
}: {
  a: ResearchResult;
  b: ResearchResult;
  onReset: () => void;
}) {
  const { winner, reason } = pickWinner(a, b);
  const winCls = winner
    ? (winner.verdict?.toUpperCase() === "INVEST" ? "invest" : winner.verdict?.toUpperCase() === "HOLD" ? "hold" : "pass")
    : "draw";

  return (
    <div className="compare-report">
      {/* Winner summary */}
      <div className="winner-card">
        <div className="winner-left">
          <div className="winner-eyebrow">AI Comparison Result</div>
          <div className="winner-name">
            {winner ? `${winner.company} — Stronger Pick` : "Too Close to Call"}
          </div>
          <div className="winner-reason">{reason}</div>
        </div>
        <span className={`winner-badge ${winCls}`}>
          {winner ? winner.verdict : "DRAW"}
        </span>
      </div>

      {/* Head to head table */}
      <H2HTable a={a} b={b} />

      {/* Side by side columns */}
      <div className="compare-grid">
        <CmpCol result={a} />
        <CmpCol result={b} />
      </div>

      <div className="action-bar">
        <div className="action-left" />
        <button className="action-btn secondary" onClick={onReset}>
          ← New Comparison
        </button>
      </div>
    </div>
  );
}

function cleanTrigger(text?: string): string {
  if (!text) return "";
  const cleaned = text
    .replace(/^[\s•\-–—✓⚠▸]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:]$/, "");

  return cleaned.length > 92 ? `${cleaned.slice(0, 89).trim()}...` : cleaned;
}

function takeTriggers(values: Array<string | undefined>, max = 3): string[] {
  const seen = new Set<string>();
  const triggers: string[] = [];

  for (const value of values) {
    const trigger = cleanTrigger(value);
    const key = trigger.toLowerCase();
    if (!trigger || seen.has(key)) continue;
    seen.add(key);
    triggers.push(trigger);
    if (triggers.length >= max) break;
  }

  return triggers;
}

function triggerArray(
  raw?: Reasoning["whatWouldChangeOurView"],
  keys: Array<"upgradeTriggers" | "riskTriggers" | "improveTriggers" | "downgradeTriggers"> = []
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  return keys.flatMap((key) => raw[key] || []);
}

function getViewMode(result: ResearchResult, recLevel: number): ViewMode {
  const verdict = result.verdict?.toUpperCase();
  if (recLevel >= 3 || verdict === "INVEST") return "invest";
  if (recLevel <= 1 || verdict === "PASS") return "pass";
  return "hold";
}

function deriveViewChangeTriggers(
  result: ResearchResult,
  mode: ViewMode
): ViewChangeTriggers {
  const reasoning = result.reasoning || {};
  const strengths = reasoning.strengths || [];
  const risks = reasoning.risks || [];
  const explicitUpgrade = triggerArray(reasoning.whatWouldChangeOurView, [
    "upgradeTriggers",
    "improveTriggers",
  ]);
  const explicitRisk = triggerArray(reasoning.whatWouldChangeOurView, [
    "riskTriggers",
    "downgradeTriggers",
  ]);
  const flatExplicit = Array.isArray(reasoning.whatWouldChangeOurView)
    ? reasoning.whatWouldChangeOurView
    : [];

  const upgradeFallback =
    mode === "invest"
      ? strengths.map((s) => s.replace(/\bstrong\b/i, "Sustained"))
      : strengths;

  const riskFallback =
    mode === "invest"
      ? [...flatExplicit, ...risks]
      : [...risks, ...flatExplicit];

  return {
    upgrade: takeTriggers(
      [...explicitUpgrade, ...upgradeFallback],
      mode === "hold" ? 3 : 3
    ),
    risk: takeTriggers([...explicitRisk, ...riskFallback], 3),
  };
}

function firstSentences(text?: string, max = 2): string {
  const source = (text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [source];
  return sentences.slice(0, max).join(" ").trim();
}

function WhatWouldChangeView({
  triggers,
  mode,
}: {
  triggers: ViewChangeTriggers;
  mode: ViewMode;
}) {
  if (triggers.upgrade.length === 0 && triggers.risk.length === 0) return null;

  const upgradeLabel = mode === "invest" ? "Reinforcing Triggers" : "Upgrade Triggers";
  const riskLabel = mode === "pass" ? "Remaining Risk Triggers" : "Risk Triggers";

  return (
    <section className="panel-card">
      <div className="card-eyebrow">What Would Change Our View?</div>
      <div className="trigger-grid">
        <div className="bb-panel">
          <div className="bb-header bull">
            <span className="bb-indicator green" />
            {upgradeLabel}
          </div>
          <ul className="trigger-list">
            {triggers.upgrade.length > 0
              ? triggers.upgrade.map((trigger, i) => (
                  <li key={i}>
                    <span className="trigger-mark positive">✓</span>
                    {trigger}
                  </li>
                ))
              : <li style={{ color: "var(--t3)" }}>No data</li>}
          </ul>
        </div>

        <div className="bb-panel">
          <div className="bb-header bear">
            <span className="bb-indicator red" />
            {riskLabel}
          </div>
          <ul className="trigger-list">
            {triggers.risk.length > 0
              ? triggers.risk.map((trigger, i) => (
                  <li key={i}>
                    <span className="trigger-mark risk">⚠</span>
                    {trigger}
                  </li>
                ))
              : <li style={{ color: "var(--t3)" }}>No data</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function InvestmentCommittee({
  result,
  recLevel,
}: {
  result: ResearchResult;
  recLevel: number;
}) {
  const reasoning = result.reasoning || {};
  const bullPoints = takeTriggers(reasoning.strengths || [], 3);
  const bearPoints = takeTriggers(reasoning.risks || [], 3);
  const decision = REC_LABELS[recLevel] || result.verdict;
  const confidence = `${confidenceToScore(result.confidence)}%`;
  const reason = firstSentences(
    reasoning.investmentCommittee || result.analystNote || result.summary,
    2
  );

  if (bullPoints.length === 0 && bearPoints.length === 0 && !reason) return null;

  return (
    <section className="panel-card">
      <div className="card-eyebrow">Investment Committee Discussion</div>
      <div className="committee-grid">
        <div className="dash-panel">
          <div className="panel-hd">
            <span className="panel-pip" style={{ background: "var(--green)" }} />
            Bull Analyst
          </div>
          <ul className="committee-list">
            {bullPoints.length > 0
              ? bullPoints.map((point, i) => <li key={i}>{point}</li>)
              : <li>No data</li>}
          </ul>
        </div>

        <div className="dash-panel">
          <div className="panel-hd">
            <span className="panel-pip" style={{ background: "var(--red)" }} />
            Bear Analyst
          </div>
          <ul className="committee-list">
            {bearPoints.length > 0
              ? bearPoints.map((point, i) => <li key={i}>{point}</li>)
              : <li>No data</li>}
          </ul>
        </div>

        <div className="dash-panel">
          <div className="panel-hd">
            <span className="panel-pip" style={{ background: "var(--blue)" }} />
            Committee Chair Decision
          </div>
          <div className="committee-decision">
            <div>
              <span>Final Committee Decision</span>
              <strong>{decision}</strong>
            </div>
            <div>
              <span>Confidence</span>
              <strong>{confidence}</strong>
            </div>
            {reason && (
              <div>
                <span>Reason</span>
                <p>{reason}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Portfolio suitability scorecard */
function PortfolioSuitability({
  scores,
}: {
  scores: Record<string, number>;
}) {
  return (
    <div className="portfolio-section">
      <div className="section-divider">Portfolio Suitability</div>
      <div className="portfolio-inner">
        <table className="portfolio-table">
          <tbody>
            {Object.entries(scores).map(([name, score]) => {
              const cls = score >= 7 ? "high" : score >= 4 ? "medium" : "low";
              return (
                <tr key={name}>
                  <td className="pt-label">{name} Portfolio</td>
                  <td className="pt-bar">
                    <div className="pt-track">
                      <div
                        className={`pt-fill ${cls}`}
                        style={{ width: `${score * 10}%` }}
                      />
                    </div>
                  </td>
                  <td className="pt-score">{score}/10</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Fair value analysis section */
function FairValue({
  fv,
}: {
  fv: { estimate: string; upside: string | null; method: string } | null;
}) {
  if (!fv) return null;
  const isPositive = fv.upside ? fv.upside.startsWith("+") : null;

  return (
    <div className="fair-value-section">
      <div className="section-divider">Valuation Estimate</div>
      <div className="fv-inner">
        <div className="fv-item">
          <span className="fv-lbl">Fair Value Estimate</span>
          <span className="fv-val">{fv.estimate}</span>
        </div>
        {fv.upside && (
          <div className="fv-item">
            <span className="fv-lbl">Implied Upside / Downside</span>
            <span
              className={`fv-val ${isPositive ? "positive" : "negative"}`}
            >
              {fv.upside}
            </span>
          </div>
        )}
        <div className="fv-item" style={{ flex: 1 }}>
          <span className="fv-lbl">Methodology</span>
          <span className="fv-note">{fv.method}</span>
        </div>
      </div>
    </div>
  );
}

/** Research sources badges */
function Sources({
  sources,
}: {
  sources: Array<{ name: string; query: string; type: string }>;
}) {
  return (
    <div className="sources-section">
      <div className="sources-inner">
        {sources.map((s, i) => (
          <span key={i} className={`source-badge ${s.type}`}>
            <span className="source-dot" />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Collapsible research methodology */
function Methodology() {
  const [open, setOpen] = useState(false);
  return (
    <div className="methodology-section">
      <button
        className="method-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Research Methodology</span>
        <span className={`method-chevron ${open ? "open" : ""}`}>▼</span>
      </button>
      <div className={`method-body ${open ? "open" : ""}`}>
        <div className="method-steps">
          {METHODOLOGY_STEPS.map((s, i) => (
            <div className="method-step" key={i}>
              <div className="method-num">{i + 1}</div>
              <div className="method-info">
                <h4>{s.title}</h4>
                <p>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Collapsible agent trace */
function AgentTrace({ steps }: { steps: ResearchStep[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="trace-section">
      <button
        className="trace-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Agent Trace — {steps.length} tool calls</span>
        <span className={`trace-chevron ${open ? "open" : ""}`}>▼</span>
      </button>
      <div className={`trace-body ${open ? "open" : ""}`}>
        {steps.map((step, i) => {
          let inputStr = step.input;
          try {
            const parsed = JSON.parse(step.input);
            inputStr = Object.values(parsed).join(", ");
          } catch { /* keep raw */ }
          return (
            <div className="trace-row" key={i}>
              <span className="trace-n">{i + 1}</span>
              <span className={`trace-badge ${step.tool}`}>{step.tool}</span>
              <span className="trace-input">{inputStr}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** PDF / Print memo export */
function exportMemo(result: ResearchResult) {
  void result;
  window.print();
}

function AnalystContext({
  note,
  summary,
}: {
  note?: string;
  summary?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!note && !summary) return null;

  return (
    <div className="secondary-card">
      <button className="secondary-toggle" onClick={() => setOpen((v) => !v)}>
        <span>Research Context</span>
        <span className={`secondary-chevron ${open ? "open" : ""}`}>▼</span>
      </button>
      <div className={`secondary-body ${open ? "open" : ""}`}>
        <div className="secondary-panel">
          {note && (
            <>
              <div className="secondary-panel-title">Analyst Note</div>
              <div className="secondary-panel-text">{note}</div>
            </>
          )}
          {summary && (
            <>
              <div className="secondary-panel-title" style={{ marginTop: ".65rem" }}>
                Lead Analyst Summary
              </div>
              <div className="secondary-panel-text">{summary}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════ */

export default function Home() {
  const [companyName, setCompanyName]   = useState("");
  const [loading, setLoading]           = useState(false);
  const [result, setResult]             = useState<ResearchResult | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [currentStep, setCurrentStep]   = useState(0);
  const [clock, setClock]               = useState("--:--:--");

  // Live clock (client only — avoids hydration mismatch)
  useEffect(() => {
    const t = setInterval(() => setClock(getTS()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Research handler (API call unchanged) ──────────────────
  const handleResearch = useCallback(async (name?: string) => {
    const company = (name || companyName).trim();
    if (!company) return;

    setLoading(true);
    setResult(null);
    setError(null);
    setCurrentStep(0);

    const interval = setInterval(() => {
      setCurrentStep((p) => (p < LOADING_STEPS.length - 1 ? p + 1 : p));
    }, 3500);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: company }),
      });
      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json() as ResearchResult
        : { error: await res.text() } as ResearchResult;
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error || `Research failed with HTTP ${res.status}.`
        );
      }
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected error.");
    } finally {
      clearInterval(interval);
      setLoading(false);
    }
  }, [companyName]);

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") handleResearch(); };

  const resetToLanding = () => {
    setResult(null);
    setCompanyName("");
    setError(null);
    setLoading(false);
    setCompareMode(false);
    setCompareResults(null);
    setCompareError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ── Compare mode state ─────────────────────────────────────
  const [compareMode,    setCompareMode]    = useState(false);
  const [companyB,       setCompanyB]       = useState("");
  const [compareResults, setCompareResults] = useState<[ResearchResult, ResearchResult] | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError,   setCompareError]   = useState<string | null>(null);

  const handleCompare = useCallback(async () => {
    const cA = companyName.trim();
    const cB = companyB.trim();
    if (!cA || !cB) return;
    setCompareLoading(true);
    setCompareResults(null);
    setCompareError(null);
    try {
      const fetchOne = async (name: string): Promise<ResearchResult> => {
        const res = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyName: name }),
        });
        const ct = res.headers.get("content-type") || "";
        const data = ct.includes("application/json")
          ? await res.json() as ResearchResult
          : { error: await res.text() } as ResearchResult;
        if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        return data;
      };
      const [rA, rB] = await Promise.all([fetchOne(cA), fetchOne(cB)]);
      setCompareResults([rA, rB]);
    } catch (e: unknown) {
      setCompareError(e instanceof Error ? e.message : "Comparison failed.");
    } finally {
      setCompareLoading(false);
    }
  }, [companyName, companyB]);

  const resetCompare = () => {
    setCompareResults(null);
    setCompareError(null);
    setCompareLoading(false);
  };

  // ── Derived values (pure frontend) ─────────────────────────
  const isInvest  = result?.verdict?.toUpperCase() === "INVEST";
  const verdictCls = result
    ? isInvest ? "invest" : "pass"
    : "hold";

  const recLevel = result
    ? getRecommendationLevel(result.verdict, result.confidence)
    : -1;

  const viewMode = result
    ? getViewMode(result, recLevel)
    : "hold";

  const viewChangeTriggers = result
    ? deriveViewChangeTriggers(result, viewMode)
    : null;

  const portfolioScores = result
    ? derivePortfolioScores(
        result.verdict,
        result.confidence,
        result.reasoning,
        result.keyMetrics
      )
    : null;

  const fairValue = result
    ? deriveFairValue(result.keyMetrics, result.highlights)
    : null;

  const sources = result
    ? extractSources(result.researchSteps)
    : [];

  // Hero mode = landing state with no active research/compare
  const isHeroMode =
    !compareMode && !loading && !result && !error;

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <>
      {/* ── TOP BAR ── */}
      <header className="topbar">
        <div
          className="topbar-brand"
          onClick={resetToLanding}
          style={{ cursor: "pointer" }}
        >
          <span className="topbar-logo">
            <span className="topbar-logo-mark" />
            Evident
          </span>
          <div className="topbar-divider" />
          <span className="topbar-subtitle">AI Investment Research</span>
        </div>
        <div className="topbar-right">
          <span className="live-dot" />
          <span>LIVE</span>
          <span style={{ color: "var(--b2)" }}>|</span>
          <span>{getDate()}</span>
          <span style={{ color: "var(--b2)" }}>|</span>
          <span>{clock}</span>
        </div>
      </header>

      <div className={`shell${isHeroMode ? "" : " shell-active"}`}>

        {/* ══════════════════════════════════════════════════
            HERO — shown only on landing (no active research)
        ══════════════════════════════════════════════════ */}
        {isHeroMode && (
          <div className="hero">

            {/* Animated financial chart background */}
            <svg className="hero-bg-chart" viewBox="0 0 1400 280" fill="none" preserveAspectRatio="none">
              <defs>
                <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%"  stopColor="#4c78ff" stopOpacity="0" />
                  <stop offset="25%" stopColor="#4c78ff" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#4c78ff" stopOpacity="0.3" />
                </linearGradient>
                <linearGradient id="lg2" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%"  stopColor="#1f8f60" stopOpacity="0" />
                  <stop offset="30%" stopColor="#1f8f60" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#1f8f60" stopOpacity="0.2" />
                </linearGradient>
                <linearGradient id="lg3" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%"  stopColor="#b57b2f" stopOpacity="0" />
                  <stop offset="40%" stopColor="#b57b2f" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#b57b2f" stopOpacity="0.15" />
                </linearGradient>
                <linearGradient id="fillLg1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"  stopColor="#4c78ff" stopOpacity="0.07" />
                  <stop offset="100%" stopColor="#4c78ff" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* Subtle grid lines */}
              {[70, 140, 210].map(y => (
                <line key={y} x1="0" y1={y} x2="1400" y2={y} stroke="#e4eaf2" strokeWidth="0.6" />
              ))}
              {/* Fill under primary line */}
              <path
                d="M0,230 C80,210 160,180 260,155 C340,135 390,158 470,140 C560,120 620,90 720,72 C810,56 870,82 960,65 C1050,48 1130,35 1220,30 C1290,26 1350,32 1400,28 L1400,280 L0,280 Z"
                fill="url(#fillLg1)"
              />
              {/* Primary line — main bullish trend */}
              <path
                className="chart-path-1"
                d="M0,230 C80,210 160,180 260,155 C340,135 390,158 470,140 C560,120 620,90 720,72 C810,56 870,82 960,65 C1050,48 1130,35 1220,30 C1290,26 1350,32 1400,28"
                stroke="url(#lg1)" strokeWidth="2.2" fill="none"
              />
              {/* Secondary line */}
              <path
                className="chart-path-2"
                d="M0,255 C100,238 200,218 310,200 C400,185 450,205 540,190 C630,174 700,148 800,138 C890,128 950,148 1050,132 C1140,118 1240,102 1400,95"
                stroke="url(#lg2)" strokeWidth="1.6" fill="none"
              />
              {/* Tertiary line */}
              <path
                className="chart-path-3"
                d="M0,268 C120,255 250,240 380,225 C470,214 510,228 600,216 C700,202 780,182 880,172 C970,162 1060,178 1180,162 C1280,148 1350,138 1400,132"
                stroke="url(#lg3)" strokeWidth="1.3" fill="none"
              />
            </svg>

            {/* Floating insight cards */}
            <div className="hero-fc hero-fc-1">
              <div className="hero-fc-header">
                <span className="hero-fc-ticker">AAPL</span>
                <span className="hero-fc-pill invest">Invest</span>
              </div>
              <div className="hero-fc-meta">
                <span className="hero-fc-dot" />
                HIGH · 91% confidence
              </div>
            </div>

            <div className="hero-fc hero-fc-2">
              <div className="hero-fc-header">
                <span className="hero-fc-ticker">TCS.NS</span>
                <span className="hero-fc-pill invest">Invest</span>
              </div>
              <div className="hero-fc-meta">
                <span className="hero-fc-dot" />
                HIGH · 87% confidence
              </div>
            </div>

            <div className="hero-fc hero-fc-3">
              <div className="hero-fc-header">
                <span className="hero-fc-ticker">MSFT</span>
                <span className="hero-fc-pill invest">Invest</span>
              </div>
              <div className="hero-fc-meta">
                <span className="hero-fc-dot" />
                MEDIUM · 74% confidence
              </div>
            </div>

            {/* Main content */}
            <div className="hero-content">
              <div className="hero-badge">
                <span className="hero-badge-dot" />
                Institutional AI Research
              </div>

              <h1 className="hero-headline">
                Every investment,<br />
                <em>researched instantly.</em>
              </h1>

              <p className="hero-sub">
                Evident delivers analyst-grade research on any listed company
                in under 60 seconds — powered by AI, built for serious investors.
              </p>

              {/* Hero search */}
              <div className="hero-search-wrap">
                <div className="hero-search">
                  <span className="hero-search-prefix">›</span>
                  <input
                    id="company-input"
                    type="text"
                    className="hero-search-input"
                    placeholder="Search any company — Infosys, AAPL, RELIANCE..."
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    onKeyDown={onKey}
                    disabled={loading}
                    autoFocus
                  />
                  <button
                    id="research-btn"
                    className="hero-search-btn"
                    onClick={() => handleResearch()}
                    disabled={loading || !companyName.trim()}
                  >
                    Analyze
                  </button>
                </div>
              </div>

              {/* Quick tickers */}
              <div className="hero-tickers">
                {QUICK_TICKERS.map((t) => (
                  <button
                    key={t}
                    className="hero-ticker-chip"
                    onClick={() => { setCompanyName(t); handleResearch(t); }}
                    disabled={loading}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Compare CTA — clearly separated from tickers */}
              <div className="hero-compare-row">
                <span className="hero-compare-or">or</span>
                <button
                  className="hero-compare-cta"
                  onClick={() => setCompareMode(true)}
                >
                  <span className="hero-compare-cta-icon">⇄</span>
                  Compare two companies
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            ACTIVE SHELL — shown when researching / results
        ══════════════════════════════════════════════════ */}
        {!isHeroMode && (
          <>
            {/* ── MODE TOGGLE ── */}
            <div className="mode-toggle-bar">
              <button
                className={`mode-btn ${!compareMode ? "active" : ""}`}
                onClick={() => { setCompareMode(false); resetCompare(); }}
              >
                Single Research
              </button>
              <button
                className={`mode-btn ${compareMode ? "active" : ""}`}
                onClick={() => { setCompareMode(true); setResult(null); }}
              >
                ⇄ Compare
              </button>
            </div>

            {!compareMode ? (
              <>
                {/* ── SINGLE COMMAND BAR ── */}
                <div className="cmd-bar">
                  <span className="cmd-prefix">&gt;</span>
                  <input
                    id="company-input-active"
                    type="text"
                    className="cmd-input"
                    placeholder="Enter company name or ticker..."
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    onKeyDown={onKey}
                    disabled={loading}
                    autoFocus
                  />
                  <button
                    id="research-btn-active"
                    className="cmd-run"
                    onClick={() => handleResearch()}
                    disabled={loading || !companyName.trim()}
                  >
                    {loading ? "RUNNING..." : "ANALYZE"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* ── COMPARE INPUT BAR ── */}
                <div className="compare-bar">
                  <div className="compare-input-wrap">
                    <span className="compare-label">A&gt;</span>
                    <input
                      className="compare-input"
                      placeholder="Company A (e.g. TCS)"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      disabled={compareLoading}
                      autoFocus
                    />
                  </div>
                  <div className="compare-input-wrap">
                    <span className="compare-label">B&gt;</span>
                    <input
                      className="compare-input"
                      placeholder="Company B (e.g. Infosys)"
                      value={companyB}
                      onChange={(e) => setCompanyB(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCompare(); }}
                      disabled={compareLoading}
                    />
                  </div>
                </div>
                <div className="compare-run-bar">
                  <button
                    className="compare-run"
                    onClick={handleCompare}
                    disabled={compareLoading || !companyName.trim() || !companyB.trim()}
                  >
                    {compareLoading ? "RESEARCHING BOTH..." : "COMPARE"}
                  </button>
                  {compareResults && (
                    <button className="compare-reset" onClick={resetCompare}>
                      Clear
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ── LOADING ── */}
        {!compareMode && loading && (
          <div className="loading-pane">
            <div className="progress-track">
              <div className="progress-fill" />
            </div>
            <div className="loading-lbl">
              Researching <strong>{companyName}</strong>
            </div>
            <div className="loading-sub">ETA ~20–40s · Powered by OpenRouter</div>
            <ul className="loading-log">
              {LOADING_STEPS.map((s, i) => (
                <li key={i} className={i === currentStep ? "active" : i < currentStep ? "done" : ""}>
                  <span className="log-marker">
                    {i < currentStep ? "✓" : i === currentStep ? "▸" : "·"}
                  </span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── COMPARE LOADING ── */}
        {compareMode && compareLoading && (
          <div className="compare-loading">
            <div className="compare-loading-item">
              <div className="compare-loading-dot" />
              <span>Researching <strong>{companyName}</strong>…</span>
            </div>
            <span className="compare-loading-vs">VS</span>
            <div className="compare-loading-item">
              <div className="compare-loading-dot" />
              <span>Researching <strong>{companyB}</strong>…</span>
            </div>
          </div>
        )}

        {/* ── COMPARE ERROR ── */}
        {compareMode && compareError && (
          <div className="error-bar">
            <p>ERROR: {compareError}</p>
            <button className="error-retry" onClick={handleCompare}>RETRY</button>
          </div>
        )}

        {/* ── COMPARE RESULT ── */}
        {compareMode && compareResults && (
          <ComparisonView
            a={compareResults[0]}
            b={compareResults[1]}
            onReset={resetCompare}
          />
        )}

        {/* ── SINGLE ERROR ── */}
        {!compareMode && error && (
          <div className="error-bar">
            <p>ERROR: {error}</p>
            <button className="error-retry" onClick={() => handleResearch()}>RETRY</button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            REPORT
        ══════════════════════════════════════════════════ */}
        {!compareMode && result && (
          <div className="report">
            <div className="summary-grid">
              <section className="summary-card">
                <div className="card-eyebrow">Executive Summary</div>
                <div className="summary-top">
                  <div>
                    <div className="summary-title">{result.company}</div>
                    <div className="summary-meta">
                      {result.highlights?.stockTicker && <span>{result.highlights.stockTicker}</span>}
                      {result.highlights?.sector && <span>{result.highlights.sector}</span>}
                      <span>{getDate()}</span>
                      {result.duration && <span>Generated in {result.duration}</span>}
                    </div>
                  </div>
                  <div className={`status-pill ${verdictCls}`}>
                    {REC_LABELS[recLevel] || result.verdict}
                  </div>
                </div>
                <p className="summary-copy">{result.summary}</p>
                <div className="summary-stats">
                  <div className="summary-stat">
                    <span className="summary-stat-label">Confidence</span>
                    <strong>{result.confidence}</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="summary-stat-label">Recommendation</span>
                    <strong>{REC_LABELS[recLevel] || result.verdict}</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="summary-stat-label">Market Cap</span>
                    <strong>{formatMarketCap(result.highlights?.marketCap) || "N/A"}</strong>
                  </div>
                </div>
                {result.highlights?.companyOverview && (
                  <div className="summary-note">{result.highlights.companyOverview}</div>
                )}
              </section>

              <section className="panel-card">
                <div className="card-header">
                  <span className="card-title">Financial Snapshot</span>
                  {result.highlights?.marketCap && (
                    <span className="card-meta">
                      Mkt Cap: {formatMarketCap(result.highlights.marketCap)}
                    </span>
                  )}
                </div>
                <RecScale level={recLevel} />
                <ConfPill confidence={result.confidence} />
                {result.keyMetrics && (
                  <MetricsTable
                    keyMetrics={result.keyMetrics}
                    marketCap={result.highlights?.marketCap}
                  />
                )}
                <FairValue fv={fairValue} />
              </section>
            </div>

            <section className="panel-card">
              <div className="card-eyebrow">Investment Thesis</div>
              {result.reasoning && <BullBear reasoning={result.reasoning} />}
            </section>

            {viewChangeTriggers && (
              <WhatWouldChangeView
                triggers={viewChangeTriggers}
                mode={viewMode}
              />
            )}

            <InvestmentCommittee result={result} recLevel={recLevel} />

            {result.reasoning && (
              <section className="panel-card">
                <div className="card-eyebrow">Fundamental Analysis</div>
                <div className="dash-grid">
                  {result.reasoning.financialHealth && (
                    <div className="dash-panel">
                      <div className="panel-hd">
                        <span className="panel-pip" style={{ background: "var(--blue)" }} />
                        Financial Health
                      </div>
                      <p className="panel-body">{result.reasoning.financialHealth}</p>
                    </div>
                  )}
                  {result.reasoning.growthPotential && (
                    <div className="dash-panel">
                      <div className="panel-hd">
                        <span className="panel-pip" style={{ background: "var(--green)" }} />
                        Growth Potential
                      </div>
                      <p className="panel-body">{result.reasoning.growthPotential}</p>
                    </div>
                  )}
                  {result.reasoning.competitivePosition && (
                    <div className="dash-panel">
                      <div className="panel-hd">
                        <span className="panel-pip" style={{ background: "var(--amber)" }} />
                        Competitive Position
                      </div>
                      <p className="panel-body">{result.reasoning.competitivePosition}</p>
                    </div>
                  )}
                  {result.reasoning.recentDevelopments && (
                    <div className="dash-panel">
                      <div className="panel-pip" style={{ background: "var(--red)" }} />
                      <div className="panel-hd">
                        Recent Developments
                      </div>
                      <p className="panel-body">{result.reasoning.recentDevelopments}</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {portfolioScores && (
              <section className="panel-card">
                <div className="card-eyebrow">Portfolio Suitability</div>
                <PortfolioSuitability scores={portfolioScores} />
              </section>
            )}

            <AnalystContext note={result.analystNote} summary={result.analystNote || result.summary} />

            {sources.length > 0 && (
              <section className="secondary-card">
                <div className="secondary-toggle">
                  <span>Research Sources</span>
                </div>
                <div className="secondary-body open">
                  <Sources sources={sources} />
                </div>
              </section>
            )}

            <Methodology />

            {result.researchSteps && result.researchSteps.length > 0 && (
              <AgentTrace steps={result.researchSteps} />
            )}

            <div className="bottom-border" />

            <div className="action-bar">
              <div className="action-left">
                <button className="action-btn primary" onClick={() => exportMemo(result)}>
                  Export Investment Memo (PDF)
                </button>
              </div>
              <button
                className="action-btn secondary"
                onClick={() => {
                  setResult(null);
                  setCompanyName("");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                ← New Research
              </button>
            </div>
          </div>
        )}

        {/* ── FOOTER ── */}
        <footer className="terminal-footer">
          Evident v2.0 <span>·</span> Next.js <span>·</span>
          LangChain.js <span>·</span> OpenRouter <span>·</span>
          Alpha Vantage <span>·</span> Serper
        </footer>
      </div>
    </>
  );
}
