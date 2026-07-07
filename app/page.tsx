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
  function valueClass(key: string, raw: string): string {
    const lk = key.toLowerCase();
    const isPct =
      lk.includes("growth") || lk.includes("margin") || lk.includes("return");
    if (!isPct) return "";
    const n = parseFloat(raw.replace(/[^0-9.-]/g, ""));
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
      const data: ResearchResult = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error || "Research failed.");
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected error.");
    } finally {
      clearInterval(interval);
      setLoading(false);
    }
  }, [companyName]);

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") handleResearch(); };

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

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <>
      {/* ── TOP BAR ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className="topbar-logo">AIRA</span>
          <div className="topbar-divider" />
          <span className="topbar-subtitle">AI Investment Research Agent</span>
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

      <div className="shell">

        {/* ── COMMAND BAR ── */}
        <div className="cmd-bar">
          <span className="cmd-prefix">&gt;</span>
          <input
            id="company-input"
            type="text"
            className="cmd-input"
            placeholder="Enter company name or ticker (e.g., Infosys, AAPL, RELIANCE)..."
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            onKeyDown={onKey}
            disabled={loading}
            autoFocus
          />
          <button
            id="research-btn"
            className="cmd-run"
            onClick={() => handleResearch()}
            disabled={loading || !companyName.trim()}
          >
            {loading ? "RUNNING..." : "ANALYZE"}
          </button>
        </div>

        <div className="ticker-row">
          {QUICK_TICKERS.map((t) => (
            <button
              key={t}
              className="ticker-chip"
              onClick={() => { setCompanyName(t); handleResearch(t); }}
              disabled={loading}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ── EMPTY ── */}
        {!loading && !result && !error && (
          <div className="empty">
            <h2>No Active Research</h2>
            <p>Type a company name and press ANALYZE to begin</p>
            <div className="empty-kbd">
              Press <kbd>Enter</kbd> to run analysis
            </div>
          </div>
        )}

        {/* ── LOADING ── */}
        {loading && (
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

        {/* ── ERROR ── */}
        {error && (
          <div className="error-bar">
            <p>ERROR: {error}</p>
            <button className="error-retry" onClick={() => handleResearch()}>RETRY</button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            REPORT
        ══════════════════════════════════════════════════ */}
        {result && (
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
          AIRA v2.0 <span>·</span> Next.js <span>·</span>
          LangChain.js <span>·</span> OpenRouter <span>·</span>
          Alpha Vantage <span>·</span> Serper
        </footer>
      </div>
    </>
  );
}
