import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type BenchmarkSource = "http" | "manual" | "telemetry";

export interface DashboardSummary {
  span: string;
  source: BenchmarkSource;
  count: number;
  okCount: number;
  errorCount: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface DashboardRun {
  schemaVersion: number;
  runId: string;
  timestamp: string;
  server: {
    url: string;
    version?: string;
    features?: string[];
    revision?: string;
    branch?: string;
    dirty?: boolean;
  };
  client: {
    revision?: string;
    bun?: string;
    node?: string;
    platform?: string;
    arch?: string;
    cpu?: string;
    logicalCpus?: number;
    memoryBytes?: number;
  };
  config: {
    iterations: number;
    warmupIterations: number;
    sequential: boolean;
    duckDb: boolean;
    label?: string;
    notes?: string;
  };
  records: number;
  summaries: DashboardSummary[];
}

export interface DashboardData {
  generatedAt: string;
  runs: DashboardRun[];
  baselineRunIds: string[];
}

export interface WriteDashboardOptions {
  outputDir: string;
  baselineDir?: string;
  baselinePaths?: string[];
  dashboardPath?: string;
}

export async function writeDashboard(options: WriteDashboardOptions): Promise<string> {
  const dashboardPath = options.dashboardPath ?? join(options.outputDir, "index.html");
  const data = await loadDashboardData(
    options.outputDir,
    options.baselineDir,
    options.baselinePaths,
  );
  await mkdir(dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, renderDashboard(data));
  return dashboardPath;
}

export async function loadDashboardData(
  outputDir: string,
  baselineDir = join("benchmarks", "baselines"),
  extraBaselinePaths: string[] = [],
): Promise<DashboardData> {
  const runFiles = await matchingFiles(outputDir, (name) => name.endsWith(".summary.json"));
  const baselineFiles = [
    ...(await matchingFiles(baselineDir, (name) => name.endsWith(".json"))),
    ...extraBaselinePaths,
  ];
  const runsById = new Map<string, DashboardRun>();
  const baselineRunIds = new Set<string>();

  for (const path of runFiles) {
    const run = await readRun(path);
    runsById.set(run.runId, run);
  }
  for (const path of new Set(baselineFiles)) {
    const run = await readRun(path);
    baselineRunIds.add(run.runId);
    runsById.set(run.runId, run);
  }

  return {
    generatedAt: new Date().toISOString(),
    runs: [...runsById.values()].sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    ),
    baselineRunIds: [...baselineRunIds],
  };
}

async function matchingFiles(
  directory: string,
  matches: (name: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && matches(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRun(path: string): Promise<DashboardRun> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<DashboardRun>;
  if (
    typeof parsed.runId !== "string" ||
    typeof parsed.timestamp !== "string" ||
    !Array.isArray(parsed.summaries)
  ) {
    throw new Error(`Invalid benchmark summary: ${basename(path)}`);
  }
  return parsed as DashboardRun;
}

export function renderDashboard(data: DashboardData): string {
  const serialized = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>TinyCloud benchmark history</title>
  <style>
    :root {
      --ink: #20263c;
      --ink-soft: #4d5878;
      --muted: #626d88;
      --brand: #4573b9;
      --brand-deep: #282f4b;
      --brand-soft: #e8eef8;
      --sky: #7db0d2;
      --surface: #ffffff;
      --surface-alt: #f2f5fa;
      --page: #f7f9fc;
      --line: #d7deea;
      --line-strong: #aeb9cd;
      --good: #16705a;
      --good-soft: #e1f3ed;
      --bad: #ad3f3f;
      --bad-soft: #fae9e8;
      --warning: #805d00;
      --focus: #1769c2;
      --radius: 12px;
      --shadow: 0 3px 8px rgba(40, 47, 75, 0.08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--page);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.5;
    }

    button, select { font: inherit; }

    :focus-visible {
      outline: 3px solid color-mix(in srgb, var(--focus) 72%, white);
      outline-offset: 2px;
    }

    .shell {
      width: min(1480px, calc(100% - 32px));
      margin: 0 auto;
    }

    header {
      background: var(--brand-deep);
      color: white;
      padding: 34px 0 30px;
    }

    .header-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
    }

    h1, h2, h3 {
      margin: 0;
      font-weight: 650;
      letter-spacing: -0.025em;
      text-wrap: balance;
    }

    h1 { font-size: 2rem; }
    h2 { font-size: 1.25rem; }
    h3 { font-size: 1rem; letter-spacing: -0.01em; }

    .lede {
      max-width: 70ch;
      margin: 8px 0 0;
      color: #dce6f5;
      overflow-wrap: anywhere;
      text-wrap: pretty;
    }

    .local-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: none;
      border: 1px solid #71809f;
      border-radius: 999px;
      padding: 7px 11px;
      color: #eef4fc;
      font-size: 0.82rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .local-badge::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #8bd5bd;
    }

    main { padding: 24px 0 56px; }

    .summary-strip {
      display: flex;
      flex-wrap: wrap;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }

    .summary-strip > div {
      min-width: 170px;
      flex: 1;
      padding: 17px 20px;
    }

    .summary-strip > div + div { border-left: 1px solid var(--line); }

    dt {
      margin-bottom: 3px;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 600;
    }

    dd {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 650;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 18px;
      margin-top: 18px;
      align-items: start;
    }

    .panel {
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }

    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--line);
    }

    .panel-head p {
      max-width: 70ch;
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 14px 20px;
      background: var(--surface-alt);
      border-bottom: 1px solid var(--line);
    }

    label {
      min-width: 0;
      display: grid;
      gap: 4px;
      color: var(--ink-soft);
      font-size: 0.75rem;
      font-weight: 600;
    }

    select {
      max-width: 100%;
      min-height: 38px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: var(--surface);
      color: var(--ink);
      padding: 7px 30px 7px 10px;
    }

    .span-control { flex: 1 1 360px; }
    .span-control select { width: 100%; }

    .chart-wrap { padding: 18px 18px 8px; }

    #trend-chart {
      display: block;
      width: 100%;
      min-height: 330px;
      overflow: visible;
    }

    .chart-empty {
      min-height: 330px;
      display: grid;
      place-items: center;
      color: var(--muted);
      text-align: center;
    }

    .chart-note {
      margin: 0;
      padding: 0 20px 18px;
      color: var(--muted);
      font-size: 0.82rem;
    }

    .side-panel { position: sticky; top: 16px; }

    .side-body { padding: 18px 20px 20px; }

    .side-body p {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .revision-list {
      display: grid;
      gap: 14px;
      margin: 0;
    }

    .revision-list dd {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    .section { margin-top: 18px; }

    .stage-controls { padding-bottom: 14px; }

    .stage-flow {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      align-items: stretch;
      padding: 22px 20px 20px;
      gap: 24px;
    }

    .stage {
      position: relative;
      min-height: 112px;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
      background: var(--surface-alt);
    }

    .stage:not(:last-child)::after {
      content: "→";
      position: absolute;
      top: 42px;
      right: -19px;
      color: var(--brand);
      font-size: 1.3rem;
      font-weight: 700;
    }

    .stage .stage-label {
      display: block;
      color: var(--muted);
      font-size: 0.76rem;
      font-weight: 650;
    }

    .stage .stage-value {
      display: block;
      margin-top: 7px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.25rem;
      font-weight: 700;
    }

    .stage .stage-detail {
      display: block;
      margin-top: 5px;
      color: var(--ink-soft);
      font-size: 0.78rem;
    }

    .table-wrap { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }

    th, td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
      text-align: right;
      white-space: nowrap;
    }

    th {
      background: var(--surface-alt);
      color: var(--ink-soft);
      font-size: 0.75rem;
      font-weight: 650;
    }

    th:first-child, td:first-child { text-align: left; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #f8fafe; }

    .span-name {
      max-width: 480px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .source {
      display: inline-flex;
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--brand-soft);
      color: var(--brand-deep);
      font-size: 0.71rem;
      font-weight: 700;
    }

    .delta {
      display: inline-block;
      min-width: 66px;
      border-radius: 6px;
      padding: 2px 5px;
      text-align: right;
      font-weight: 650;
    }

    .delta.good { background: var(--good-soft); color: var(--good); }
    .delta.bad { background: var(--bad-soft); color: var(--bad); }
    .delta.neutral { color: var(--muted); }

    .baseline-mark {
      margin-left: 7px;
      color: var(--brand);
      font-size: 0.72rem;
      font-weight: 700;
    }

    .empty-state {
      padding: 44px 20px;
      text-align: center;
      color: var(--muted);
    }

    footer {
      padding: 0 0 40px;
      color: var(--muted);
      font-size: 0.8rem;
      text-align: center;
    }

    @media (max-width: 980px) {
      .workspace { grid-template-columns: minmax(0, 1fr); }
      .side-panel { position: static; }
      .stage-flow { grid-template-columns: 1fr 1fr; }
      .stage:nth-child(2)::after { display: none; }
    }

    @media (max-width: 640px) {
      .shell { width: min(calc(100% - 20px), 1480px); }
      header { padding: 24px 0; }
      .header-row { align-items: flex-start; flex-direction: column; }
      .header-row > div { min-width: 0; }
      h1 { font-size: 1.65rem; }
      .summary-strip { display: block; }
      .summary-strip > div + div {
        border-top: 1px solid var(--line);
        border-left: 0;
      }
      .panel-head { display: block; }
      .stage-flow { grid-template-columns: 1fr; }
      .stage:not(:last-child)::after {
        content: "↓";
        display: block;
        top: auto;
        right: 50%;
        bottom: -24px;
        transform: translateX(50%);
      }
      #trend-chart { min-height: 280px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell header-row">
      <div>
        <h1>TinyCloud benchmark history</h1>
        <p class="lede">Compare Node SDK operations and their underlying HTTP request stages across local optimization runs.</p>
      </div>
      <span class="local-badge">Local data only</span>
    </div>
  </header>

  <main class="shell">
    <dl class="summary-strip" aria-label="Benchmark history summary">
      <div><dt>Recorded runs</dt><dd id="run-count">—</dd></div>
      <div><dt>Latest run</dt><dd id="latest-date">—</dd></div>
      <div><dt>Baseline</dt><dd id="baseline-id">—</dd></div>
      <div><dt>Latest node</dt><dd id="node-version">—</dd></div>
    </dl>

    <div class="workspace">
      <section class="panel" aria-labelledby="trend-title">
        <div class="panel-head">
          <div>
            <h2 id="trend-title">Latency over time</h2>
            <p>Each point is one complete benchmark run. Lower is faster; the dotted rule is the selected baseline.</p>
          </div>
        </div>
        <div class="controls">
          <label class="span-control">Measured span
            <select id="span-select"></select>
          </label>
          <label>Percentile
            <select id="metric-select">
              <option value="p50Ms">p50</option>
              <option value="p95Ms">p95</option>
              <option value="p99Ms">p99</option>
              <option value="meanMs">mean</option>
            </select>
          </label>
        </div>
        <div class="chart-wrap" id="chart-wrap">
          <svg id="trend-chart" role="img" aria-labelledby="chart-title chart-description"></svg>
        </div>
        <p class="chart-note" id="chart-note">—</p>
      </section>

      <aside class="panel side-panel" aria-labelledby="environment-title">
        <div class="panel-head"><h2 id="environment-title">Latest environment</h2></div>
        <div class="side-body">
          <p>Comparisons are most trustworthy when the node, SDK, runtime, and machine match.</p>
          <dl class="revision-list" id="environment-list"></dl>
        </div>
      </aside>
    </div>

    <section class="panel section" aria-labelledby="stage-title">
      <div class="panel-head">
        <div>
          <h2 id="stage-title">Request sequence</h2>
          <p>Latest-run timing for one operation. HTTP milestones are nested inside the SDK operation and are not additive.</p>
        </div>
      </div>
      <div class="controls stage-controls">
        <label class="span-control">Operation
          <select id="operation-select"></select>
        </label>
      </div>
      <div class="stage-flow" id="stage-flow"></div>
    </section>

    <section class="panel section" aria-labelledby="latest-title">
      <div class="panel-head">
        <div>
          <h2 id="latest-title">Latest run by measured span</h2>
          <p>Operation totals, HTTP response milestones, and any SDK telemetry are kept separate.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Span</th><th>Source</th><th>Samples</th><th>Mean</th><th>p50</th><th>p95</th><th>p99</th><th>vs baseline p50</th></tr></thead>
          <tbody id="latest-body"></tbody>
        </table>
      </div>
    </section>

    <section class="panel section" aria-labelledby="runs-title">
      <div class="panel-head">
        <div>
          <h2 id="runs-title">Run history</h2>
          <p>Every local summary is retained; named baselines are marked and deduplicated by run ID.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Run</th><th>Date</th><th>Iterations</th><th>Node revision</th><th>SDK revision</th><th>Runtime</th><th>Machine</th></tr></thead>
          <tbody id="runs-body"></tbody>
        </table>
      </div>
    </section>
  </main>

  <footer class="shell">Generated <span id="generated-at">—</span> from repo-local benchmark summaries. No network connection is required.</footer>

  <script type="application/json" id="benchmark-data">${serialized}</script>
  <script>
    (() => {
      "use strict";
      const data = JSON.parse(document.getElementById("benchmark-data").textContent);
      const runs = data.runs;
      const latest = runs.at(-1);
      const baseline = runs.find((run) => data.baselineRunIds.includes(run.runId)) || runs[0];
      const spanSelect = document.getElementById("span-select");
      const metricSelect = document.getElementById("metric-select");
      const operationSelect = document.getElementById("operation-select");
      const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
      const chartDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const metricLabels = { p50Ms: "p50", p95Ms: "p95", p99Ms: "p99", meanMs: "mean" };

      const text = (id, value) => {
        document.getElementById(id).textContent = value;
      };
      const short = (value) => value ? value.slice(0, 8) : "unknown";
      const runLabel = (run) => run?.config.label || run?.runId || "unknown";
      const ms = (value) => Number.isFinite(value) ? number.format(value) + " ms" : "—";
      const memory = (bytes) => Number.isFinite(bytes) ? number.format(bytes / 1073741824) + " GB" : "unknown";
      const summaryFor = (run, span) => run?.summaries.find((item) => item.span === span);
      const operationName = (span) => span.split(".http.")[0];

      function option(value, label = value) {
        const node = document.createElement("option");
        node.value = value;
        node.textContent = label;
        return node;
      }

      function populateControls() {
        const spans = [...new Set(runs.flatMap((run) => run.summaries.map((item) => item.span)))].sort();
        const preferred = spans.find((span) => span === "sdk.kv.get.http.headers.post.invoke") || spans[0];
        spans.forEach((span) => spanSelect.append(option(span)));
        spanSelect.value = preferred || "";

        const operations = [...new Set(spans.map(operationName).filter((span) =>
          runs.some((run) => run.summaries.some((item) => item.source === "manual" && item.span === span))
        ))].sort();
        operations.forEach((span) => operationSelect.append(option(span)));
        operationSelect.value = operations.find((span) => span === "sdk.kv.get") || operations[0] || "";
      }

      function renderSummary() {
        text("run-count", String(runs.length));
        text("latest-date", latest ? date.format(new Date(latest.timestamp)) : "No runs");
        text("baseline-id", baseline ? (baseline.config.label || chartDate.format(new Date(baseline.timestamp))) : "Not set");
        text("node-version", latest?.server.version || "unknown");
        text("generated-at", date.format(new Date(data.generatedAt)));
      }

      function addEnvironmentTerm(list, label, value) {
        const wrapper = document.createElement("div");
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        wrapper.append(term, detail);
        list.append(wrapper);
      }

      function renderEnvironment() {
        const list = document.getElementById("environment-list");
        list.replaceChildren();
        if (!latest) return;
        addEnvironmentTerm(list, "Node", (latest.server.version || "unknown") + " · " + short(latest.server.revision));
        addEnvironmentTerm(
          list,
          "SDK",
          [
            short(latest.client.revision),
            latest.client.branch,
            latest.client.dirty === true ? "dirty tree" : undefined,
          ].filter(Boolean).join(" · "),
        );
        addEnvironmentTerm(list, "Runtime", "Bun " + (latest.client.bun || "unknown") + " · " + (latest.client.node || "unknown"));
        addEnvironmentTerm(list, "Machine", (latest.client.cpu || latest.client.arch || "unknown") + " · " + memory(latest.client.memoryBytes));
        addEnvironmentTerm(list, "Sample", latest.config.iterations + " measured · " + latest.config.warmupIterations + " warmup");
      }

      function svgElement(name, attributes = {}) {
        const node = document.createElementNS("http://www.w3.org/2000/svg", name);
        Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
        return node;
      }

      function renderChart() {
        const chart = document.getElementById("trend-chart");
        const span = spanSelect.value;
        const metric = metricSelect.value;
        const points = runs.map((run) => {
          const summary = summaryFor(run, span);
          return summary ? { run, summary, value: summary[metric] } : null;
        }).filter(Boolean);
        chart.replaceChildren();

        if (!points.length) {
          const message = document.createElement("div");
          message.className = "chart-empty";
          message.textContent = "No runs contain this measured span.";
          document.getElementById("chart-wrap").replaceChildren(message);
          return;
        }
        const wrap = document.getElementById("chart-wrap");
        if (!chart.isConnected) {
          wrap.replaceChildren(chart);
        }

        const width = Math.max(680, wrap.clientWidth - 36);
        const height = 330;
        const margin = { top: 22, right: 28, bottom: 54, left: 64 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        const values = points.map((point) => point.value);
        const baselineValue = summaryFor(baseline, span)?.[metric];
        const maxValue = Math.max(...values, Number.isFinite(baselineValue) ? baselineValue : 0, 0.5) * 1.15;
        const x = (index) => margin.left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
        const y = (value) => margin.top + plotHeight - value / maxValue * plotHeight;
        chart.setAttribute("viewBox", "0 0 " + width + " " + height);
        chart.setAttribute("height", String(height));

        const title = svgElement("title", { id: "chart-title" });
        title.textContent = metricLabels[metric] + " latency for " + span;
        const description = svgElement("desc", { id: "chart-description" });
        description.textContent = points.map((point) =>
          date.format(new Date(point.run.timestamp)) + ": " + ms(point.value)
        ).join("; ");
        chart.append(title, description);

        for (let tick = 0; tick <= 4; tick += 1) {
          const value = maxValue * tick / 4;
          const tickY = y(value);
          chart.append(svgElement("line", {
            x1: margin.left, x2: width - margin.right, y1: tickY, y2: tickY,
            stroke: "#d7deea", "stroke-width": 1,
          }));
          const label = svgElement("text", {
            x: margin.left - 10, y: tickY + 4, "text-anchor": "end",
            fill: "#68738f", "font-size": 11,
          });
          label.textContent = number.format(value) + " ms";
          chart.append(label);
        }

        if (Number.isFinite(baselineValue)) {
          const baselineY = y(baselineValue);
          chart.append(svgElement("line", {
            x1: margin.left, x2: width - margin.right, y1: baselineY, y2: baselineY,
            stroke: "#805d00", "stroke-width": 1.5, "stroke-dasharray": "6 5",
          }));
          const label = svgElement("text", {
            x: width - margin.right, y: Math.max(12, baselineY - 7), "text-anchor": "end",
            fill: "#805d00", "font-size": 11, "font-weight": 650,
          });
          label.textContent = "baseline " + ms(baselineValue);
          chart.append(label);
        }

        const path = points.map((point, index) =>
          (index === 0 ? "M" : "L") + x(index) + " " + y(point.value)
        ).join(" ");
        chart.append(svgElement("path", {
          d: path, fill: "none", stroke: "#4573b9", "stroke-width": 2.5,
          "stroke-linecap": "round", "stroke-linejoin": "round",
        }));

        points.forEach((point, index) => {
          const group = svgElement("g", { tabindex: 0, role: "img" });
          const pointTitle = svgElement("title");
          pointTitle.textContent =
            date.format(new Date(point.run.timestamp)) +
            " · " + ms(point.value) +
            " · " + point.summary.count + " samples";
          group.append(pointTitle);
          group.append(svgElement("circle", {
            cx: x(index), cy: y(point.value), r: 5,
            fill: data.baselineRunIds.includes(point.run.runId) ? "#805d00" : "#ffffff",
            stroke: "#4573b9", "stroke-width": 2.5,
          }));
          chart.append(group);

          if (points.length <= 8 || index === 0 || index === points.length - 1) {
            const label = svgElement("text", {
              x: x(index), y: height - 25, "text-anchor": "middle",
              fill: "#68738f", "font-size": 10,
            });
            label.textContent = point.run.config.label
              ? point.run.config.label.slice(0, 18)
              : chartDate.format(new Date(point.run.timestamp));
            chart.append(label);
          }
        });

        const latestPoint = points.at(-1);
        const delta = Number.isFinite(baselineValue) && baselineValue !== 0
          ? (latestPoint.value - baselineValue) / baselineValue * 100
          : null;
        text("chart-note",
          latestPoint
            ? "Latest " + metricLabels[metric] + ": " + ms(latestPoint.value) +
              " · " + latestPoint.summary.count + " samples" +
              (delta === null ? "." : " · " + formatDelta(delta) + " vs baseline.")
            : "No measured samples."
        );
      }

      function formatDelta(value) {
        if (!Number.isFinite(value)) return "—";
        if (Math.abs(value) < 0.05) return "no change";
        return (value > 0 ? "+" : "") + number.format(value) + "%";
      }

      function renderStages() {
        const flow = document.getElementById("stage-flow");
        flow.replaceChildren();
        if (!latest || !operationSelect.value) return;
        const operation = operationSelect.value;
        const metric = metricSelect.value;
        const manual = summaryFor(latest, operation);
        const headers = latest.summaries.find((item) =>
          item.span.startsWith(operation + ".http.headers.")
        );
        const total = latest.summaries.find((item) =>
          item.span.startsWith(operation + ".http.total.")
        );
        const residual = manual && headers ? Math.max(0, manual[metric] - headers[metric]) : null;
        const stages = [
          ["SDK entry", manual ? ms(manual[metric]) : "—", metricLabels[metric] + " end-to-end"],
          ["Client work", residual === null ? "—" : ms(residual), "derived time outside response wait"],
          ["HTTP response", headers ? ms(headers[metric]) : "—", headers ? headers.span.split(".http.headers.")[1] : "no request"],
          ["Body consumed", total ? ms(total[metric]) : "not consumed", total ? metricLabels[metric] + " total" : "SDK completes at headers"],
        ];
        stages.forEach(([label, value, detail]) => {
          const stage = document.createElement("div");
          stage.className = "stage";
          const labelNode = document.createElement("span");
          labelNode.className = "stage-label";
          labelNode.textContent = label;
          const valueNode = document.createElement("span");
          valueNode.className = "stage-value";
          valueNode.textContent = value;
          const detailNode = document.createElement("span");
          detailNode.className = "stage-detail";
          detailNode.textContent = detail;
          stage.append(labelNode, valueNode, detailNode);
          flow.append(stage);
        });
      }

      function deltaNode(current, original) {
        const node = document.createElement("span");
        node.className = "delta neutral";
        if (!Number.isFinite(current) || !Number.isFinite(original) || original === 0) {
          node.textContent = "—";
          return node;
        }
        const delta = (current - original) / original * 100;
        node.textContent = formatDelta(delta);
        if (Math.abs(delta) < 1) node.className = "delta neutral";
        else node.className = delta < 0 ? "delta good" : "delta bad";
        return node;
      }

      function cell(value, className) {
        const node = document.createElement("td");
        if (className) node.className = className;
        node.textContent = value;
        return node;
      }

      function renderLatestTable() {
        const body = document.getElementById("latest-body");
        body.replaceChildren();
        if (!latest) {
          const row = document.createElement("tr");
          const empty = cell("Run the benchmark to populate local history.");
          empty.colSpan = 8;
          empty.className = "empty-state";
          row.append(empty);
          body.append(row);
          return;
        }
        latest.summaries.forEach((summary) => {
          const row = document.createElement("tr");
          const span = cell(summary.span, "span-name");
          span.title = summary.span;
          const sourceCell = document.createElement("td");
          const source = document.createElement("span");
          source.className = "source";
          source.textContent = summary.source;
          sourceCell.append(source);
          const deltaCell = document.createElement("td");
          deltaCell.append(deltaNode(summary.p50Ms, summaryFor(baseline, summary.span)?.p50Ms));
          row.append(
            span,
            sourceCell,
            cell(String(summary.count)),
            cell(ms(summary.meanMs)),
            cell(ms(summary.p50Ms)),
            cell(ms(summary.p95Ms)),
            cell(ms(summary.p99Ms)),
            deltaCell,
          );
          body.append(row);
        });
      }

      function renderRunsTable() {
        const body = document.getElementById("runs-body");
        body.replaceChildren();
        [...runs].reverse().forEach((run) => {
          const row = document.createElement("tr");
          const runCell = cell(runLabel(run), "span-name");
          runCell.title = run.runId + (run.config.notes ? "\\n" + run.config.notes : "");
          if (data.baselineRunIds.includes(run.runId)) {
            const mark = document.createElement("span");
            mark.className = "baseline-mark";
            mark.textContent = "baseline";
            runCell.append(mark);
          }
          row.append(
            runCell,
            cell(date.format(new Date(run.timestamp))),
            cell(String(run.config.iterations)),
            cell(short(run.server.revision)),
            cell(short(run.client.revision)),
            cell("Bun " + (run.client.bun || "unknown")),
            cell(run.client.cpu || run.client.arch || "unknown"),
          );
          body.append(row);
        });
      }

      function renderAll() {
        renderChart();
        renderStages();
      }

      populateControls();
      renderSummary();
      renderEnvironment();
      renderLatestTable();
      renderRunsTable();
      renderAll();
      spanSelect.addEventListener("change", renderChart);
      metricSelect.addEventListener("change", renderAll);
      operationSelect.addEventListener("change", renderStages);
      window.addEventListener("resize", renderChart);
    })();
  </script>
</body>
</html>
`;
}

if (import.meta.main) {
  const outputDir = process.env.TC_BENCH_OUTPUT_DIR ?? join("benchmarks", "results");
  const baselineDir = process.env.TC_BENCH_BASELINE_DIR ?? join("benchmarks", "baselines");
  const dashboardPath =
    process.env.TC_BENCH_DASHBOARD_PATH ?? join(outputDir, "index.html");
  const path = await writeDashboard({ outputDir, baselineDir, dashboardPath });
  console.log(`[Bench] Wrote local dashboard: ${path}`);
}
