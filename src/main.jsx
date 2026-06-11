import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  Eye,
  FolderPlus,
  Gauge,
  HardDrive,
  Layers3,
  Loader2,
  MessageSquareText,
  Play,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  TrendingUp,
  X,
  Zap
} from "lucide-react";
import "./styles.css";

const bridge = window.tracker;

const emptyState = {
  records: [],
  sources: [],
  summary: {
    recordCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    reportedRecords: 0,
    estimatedRecords: 0,
    runningRecords: 0,
    reportedTokenShare: 0,
    models: [],
    sources: [],
    projects: [],
    daily: []
  },
  analytics: {
    requestsPerMinute: 0,
    tokensPerMinute: 0,
    runningTurns: 0,
    latestActivityAt: null
  },
  scan: {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    filesScanned: 0,
    recordsFound: 0
  },
  capture: {
    mode: "realtime",
    lastEventAt: null,
    lastParsedAt: null,
    pendingFiles: 0,
    pendingRescan: false,
    lastFilesScanned: 0,
    lastRecordsFound: 0,
    lastError: null
  },
  dataDir: ""
};

function App() {
  const [state, setState] = useState(emptyState);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [busyAction, setBusyAction] = useState("");

  useEffect(() => {
    let mounted = true;

    if (!bridge) {
      return undefined;
    }

    bridge.getState().then((nextState) => {
      if (mounted) {
        setState(mergeState(nextState));
      }
    });

    const unsubscribe = bridge.onState((nextState) => {
      setState(mergeState(nextState));
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const records = state.records || [];
  const sources = state.sources || [];
  const summary = state.summary || emptyState.summary;
  const analytics = state.analytics || emptyState.analytics;
  const scan = state.scan || emptyState.scan;
  const capture = state.capture || emptyState.capture;

  const models = useMemo(() => {
    return [...new Set(records.map((record) => record.model || "Unknown model"))].sort();
  }, [records]);

  const filteredRecords = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();
    return records.filter((record) => {
      const sourceMatches = sourceFilter === "all" || record.sourceId === sourceFilter;
      const modelMatches = modelFilter === "all" || (record.model || "Unknown model") === modelFilter;
      const queryMatches = !loweredQuery || [
        record.model,
        record.sourceName,
        record.ide,
        record.provider,
        record.projectName,
        record.projectPath,
        record.prompt,
        record.output
      ].some((value) => String(value || "").toLowerCase().includes(loweredQuery));

      return sourceMatches && modelMatches && queryMatches;
    });
  }, [records, query, sourceFilter, modelFilter]);

  const selectedRecord = filteredRecords.find((record) => record.id === selectedId) || filteredRecords[0] || null;
  const liveMode = scan.running ? "Scanning" : capture.pendingFiles > 0 ? "Queueing" : capture.mode === "realtime" ? "Live" : "Polling";
  const latestActivity = analytics.latestActivityAt || capture.lastParsedAt || scan.lastFinishedAt;
  const sourceHealth = sources.length === 0 ? "0 / 0" : `${sources.filter((source) => source.enabled && source.exists).length} / ${sources.length}`;

  useEffect(() => {
    if (selectedId && !filteredRecords.some((record) => record.id === selectedId)) {
      setSelectedId(filteredRecords[0]?.id || null);
    }
  }, [filteredRecords, selectedId]);

  async function runAction(name, action) {
    if (!bridge) {
      return;
    }

    setBusyAction(name);
    try {
      const nextState = await action();
      if (nextState) {
        setState(mergeState(nextState));
      }
    } finally {
      setBusyAction("");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <div>
            <h1>IDE Model Token Tracker</h1>
            <div className="status-line">
              <span className={liveMode === "Live" || liveMode === "Scanning" ? "pulse-dot active" : "pulse-dot"} />
              <span>{liveMode}</span>
              <span className="dot-separator" />
              <ShieldCheck size={15} />
              <span>Local ledger</span>
              <span className="dot-separator" />
              <Clock3 size={15} />
              <span>{formatAge(latestActivity)}</span>
            </div>
          </div>
        </div>

        <div className="topbar-actions">
          <IconButton
            label="Open data folder"
            title="Open data folder"
            icon={<HardDrive size={18} />}
            onClick={() => runAction("data", () => bridge.openDataFolder())}
            disabled={!bridge}
          />
          <IconButton
            label="Export JSON"
            title="Export JSON"
            icon={<Download size={18} />}
            onClick={() => runAction("export", () => bridge.exportJson())}
            disabled={!bridge}
            loading={busyAction === "export"}
          />
          <button
            className="button secondary"
            onClick={() => runAction("add", () => bridge.addSource())}
            disabled={!bridge}
            title="Add folder"
          >
            <FolderPlus size={18} />
            <span>Add Folder</span>
          </button>
          <button
            className="button primary"
            onClick={() => runAction("rescan", () => bridge.rescan())}
            disabled={!bridge || scan.running}
            title="Rescan"
          >
            {scan.running || busyAction === "rescan" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>Rescan</span>
          </button>
        </div>
      </header>

      {!bridge && (
        <section className="bridge-alert">
          <TerminalSquare size={18} />
          <span>Electron bridge unavailable.</span>
        </section>
      )}

      {(scan.lastError || capture.lastError) && (
        <section className="error-alert">
          <X size={18} />
          <span>{scan.lastError || capture.lastError}</span>
        </section>
      )}

      <section className="live-grid">
        <article className="live-panel">
          <div className="live-head">
            <span className={liveMode === "Live" || liveMode === "Scanning" ? "live-dot active" : "live-dot"} />
            <div>
              <h2>{liveMode} Capture</h2>
              <p>{scan.running ? `${scan.filesScanned} files / ${scan.recordsFound} turns` : `${capture.lastFilesScanned || scan.filesScanned} files / ${capture.lastRecordsFound || scan.recordsFound} turns`}</p>
            </div>
          </div>
          <div className="live-metrics">
            <StatusMetric label="TPM" value={formatNumber(analytics.tokensPerMinute)} icon={<Zap size={17} />} />
            <StatusMetric label="RPM" value={formatNumber(analytics.requestsPerMinute)} icon={<Radio size={17} />} />
            <StatusMetric label="Queue" value={formatNumber(capture.pendingFiles || 0)} icon={<Gauge size={17} />} />
            <StatusMetric label="Sources" value={sourceHealth} icon={<Layers3 size={17} />} />
          </div>
        </article>

        <TokenMix summary={summary} />
      </section>

      <section className="summary-grid">
        <SummaryCard icon={<Database size={20} />} label="Total Tokens" value={formatCompact(summary.totalTokens)} subvalue={`${formatCompact(summary.inputTokens)} in / ${formatCompact(summary.outputTokens)} out`} accent="green" />
        <SummaryCard icon={<MessageSquareText size={20} />} label="Captured Turns" value={formatNumber(summary.recordCount)} subvalue={`${formatNumber(summary.runningRecords)} running`} accent="blue" />
        <SummaryCard icon={<CheckCircle2 size={20} />} label="Reported Coverage" value={`${summary.reportedTokenShare || 0}%`} subvalue={`${formatNumber(summary.reportedRecords)} reported`} accent="amber" />
        <SummaryCard icon={<Bot size={20} />} label="Active Models" value={formatNumber(summary.models?.length || 0)} subvalue={`${formatNumber(summary.estimatedRecords)} estimated`} accent="rose" />
      </section>

      <section className="workspace-grid">
        <aside className="panel source-panel">
          <PanelHeading title="Sources" detail={`${sources.filter((source) => source.enabled).length} enabled`} icon={<SlidersHorizontal size={18} />} />
          <div className="source-list">
            {sources.length === 0 ? (
              <EmptyBlock title="No sources found" />
            ) : (
              sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  onToggle={(enabled) => runAction(`source-${source.id}`, () => bridge.updateSource(source.id, { enabled }))}
                  onRemove={() => runAction(`remove-${source.id}`, () => bridge.removeSource(source.id))}
                  busy={busyAction === `source-${source.id}` || busyAction === `remove-${source.id}`}
                  disabled={!bridge}
                />
              ))
            )}
          </div>
        </aside>

        <section className="panel model-panel">
          <PanelHeading title="Model Usage" detail={`${formatCompact(summary.cachedInputTokens)} cached / ${formatCompact(summary.reasoningOutputTokens)} reasoning`} icon={<Bot size={18} />} />
          <UsageBars rows={summary.models || []} />
        </section>

        <section className="panel trend-panel">
          <PanelHeading title="Daily Trend" detail={`${summary.daily?.length || 0} active days`} icon={<TrendingUp size={18} />} />
          <TrendBars rows={summary.daily || []} />
        </section>

        <section className="panel record-panel">
          <div className="panel-heading record-heading">
            <div>
              <h2>Prompt Ledger</h2>
              <p>{formatNumber(filteredRecords.length)} visible</p>
            </div>
            <div className="filters">
              <label className="search-box">
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search prompt, output, model"
                />
              </label>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="Source filter">
                <option value="all">All sources</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
              <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} aria-label="Model filter">
                <option value="all">All models</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ledger-layout">
            <div className="record-list">
              {filteredRecords.length === 0 ? (
                <EmptyBlock title="No turns captured" />
              ) : (
                filteredRecords.map((record) => (
                  <RecordRow
                    key={record.id}
                    record={record}
                    selected={selectedRecord?.id === record.id}
                    onClick={() => setSelectedId(record.id)}
                  />
                ))
              )}
            </div>

            <RecordDetail record={selectedRecord} />
          </div>
        </section>
      </section>
    </main>
  );
}

function mergeState(nextState) {
  return {
    ...emptyState,
    ...(nextState || {}),
    summary: {
      ...emptyState.summary,
      ...(nextState?.summary || {})
    },
    analytics: {
      ...emptyState.analytics,
      ...(nextState?.analytics || {})
    },
    scan: {
      ...emptyState.scan,
      ...(nextState?.scan || {})
    },
    capture: {
      ...emptyState.capture,
      ...(nextState?.capture || {})
    }
  };
}

function PanelHeading({ title, detail, icon }) {
  return (
    <div className="panel-heading">
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {icon}
    </div>
  );
}

function SummaryCard({ icon, label, value, subvalue, accent }) {
  return (
    <article className={`summary-card ${accent}`}>
      <div className="summary-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        {subvalue && <span>{subvalue}</span>}
      </div>
    </article>
  );
}

function StatusMetric({ icon, label, value }) {
  return (
    <div className="status-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TokenMix({ summary }) {
  const input = summary.inputTokens || 0;
  const output = summary.outputTokens || 0;
  const reasoning = summary.reasoningOutputTokens || 0;
  const total = Math.max(1, input + output + reasoning);
  const inputPct = Math.round((input / total) * 100);
  const outputPct = Math.round((output / total) * 100);
  const reasoningPct = Math.max(0, 100 - inputPct - outputPct);

  return (
    <article className="mix-panel">
      <div className="mix-head">
        <div>
          <h2>Token Mix</h2>
          <p>{formatCompact(summary.totalTokens)} total tokens</p>
        </div>
        <BarChart3 size={18} />
      </div>
      <div className="mix-bar">
        <span className="mix-input" style={{ width: `${inputPct}%` }} />
        <span className="mix-output" style={{ width: `${outputPct}%` }} />
        <span className="mix-reasoning" style={{ width: `${reasoningPct}%` }} />
      </div>
      <div className="mix-legend">
        <span><i className="legend-dot mix-input" />Input {formatCompact(input)}</span>
        <span><i className="legend-dot mix-output" />Output {formatCompact(output)}</span>
        <span><i className="legend-dot mix-reasoning" />Reasoning {formatCompact(reasoning)}</span>
      </div>
    </article>
  );
}

function SourceRow({ source, onToggle, onRemove, busy, disabled }) {
  return (
    <article className={source.enabled ? "source-row" : "source-row muted"}>
      <div className="source-top">
        <div>
          <h3>{source.label}</h3>
          <div className="source-meta">
            <span>{source.ide}</span>
            <span>{source.provider}</span>
            <span>{source.confidence}</span>
          </div>
        </div>
        <label className="switch" title={source.enabled ? "Disable source" : "Enable source"}>
          <input
            type="checkbox"
            checked={Boolean(source.enabled)}
            disabled={disabled || busy || !source.exists}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span />
        </label>
      </div>
      <p className="path-line">{source.rootPath}</p>
      <div className="source-foot">
        <span className={source.exists ? "source-status ready" : "source-status missing"}>
          {source.exists ? "ready" : "missing"}
        </span>
        <span>{source.lastScanAt ? formatDateTime(source.lastScanAt) : "not scanned"}</span>
        {source.removable && (
          <button className="text-button" type="button" onClick={onRemove} disabled={disabled || busy}>
            Remove
          </button>
        )}
      </div>
    </article>
  );
}

function UsageBars({ rows }) {
  if (!rows.length) {
    return <EmptyBlock title="No model usage yet" />;
  }

  const max = Math.max(...rows.map((row) => row.totalTokens || 0), 1);

  return (
    <div className="usage-list">
      {rows.slice(0, 8).map((row) => (
        <div className="usage-row" key={row.name}>
          <div className="usage-row-head">
            <span>{row.name}</span>
            <strong>{formatCompact(row.totalTokens)}</strong>
          </div>
          <div className="bar-track">
            <span style={{ width: `${Math.max(3, ((row.totalTokens || 0) / max) * 100)}%` }} />
          </div>
          <div className="usage-row-foot">
            <span>{formatNumber(row.recordCount)} turns</span>
            <span>{formatNumber(row.reportedRecords)} reported</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrendBars({ rows }) {
  const visibleRows = rows.slice(-10);
  if (!visibleRows.length) {
    return <EmptyBlock title="No trend data yet" />;
  }

  const max = Math.max(...visibleRows.map((row) => row.totalTokens || 0), 1);

  return (
    <div className="trend-list">
      {visibleRows.map((row) => (
        <div className="trend-row" key={row.name}>
          <span>{formatShortDay(row.name)}</span>
          <div className="trend-track">
            <i style={{ width: `${Math.max(4, ((row.totalTokens || 0) / max) * 100)}%` }} />
          </div>
          <strong>{formatCompact(row.totalTokens)}</strong>
        </div>
      ))}
    </div>
  );
}

function RecordRow({ record, selected, onClick }) {
  const status = record.status === "running" ? "running" : record.tokenSource;
  return (
    <button type="button" className={selected ? "record-row selected" : "record-row"} onClick={onClick}>
      <div className="record-main">
        <span className="model-name">{record.model}</span>
        <span className="prompt-preview">{compactText(record.prompt || record.output, 132)}</span>
      </div>
      <div className="record-meta">
        <span>{record.projectName || record.sourceName}</span>
        <span>{formatCompact(record.totalTokens)} tok</span>
        <span className={`pill ${status}`}>{status}</span>
      </div>
    </button>
  );
}

function RecordDetail({ record }) {
  if (!record) {
    return (
      <aside className="record-detail">
        <EmptyBlock title="No record selected" />
      </aside>
    );
  }

  const status = record.status === "running" ? "running" : record.tokenSource;

  return (
    <aside className="record-detail">
      <div className="detail-head">
        <div>
          <span className="eyebrow">{record.provider}</span>
          <h3>{record.model}</h3>
        </div>
        <span className={`pill ${status}`}>{status}</span>
      </div>

      <div className="token-strip">
        <Metric label="Input" value={formatNumber(record.inputTokens)} />
        <Metric label="Output" value={formatNumber(record.outputTokens)} />
        <Metric label="Total" value={formatNumber(record.totalTokens)} />
        <Metric label="Cached" value={formatNumber(record.cachedInputTokens || record.cacheReadTokens)} />
        <Metric label="Reasoning" value={formatNumber(record.reasoningOutputTokens)} />
      </div>

      <div className="detail-meta">
        <span>{record.sourceName}</span>
        <span>{record.projectName || "Unknown project"}</span>
        <span>{formatDateTime(record.timestamp)}</span>
      </div>

      <TextPanel title="Prompt" text={record.prompt} />
      <TextPanel title="Output" text={record.output} />

      <div className="ghost-link" title={record.filePath}>
        <Eye size={16} />
        <span>{record.filePath}</span>
      </div>
    </aside>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TextPanel({ title, text }) {
  return (
    <section className="text-panel">
      <h4>{title}</h4>
      <pre>{text || "No text captured."}</pre>
    </section>
  );
}

function EmptyBlock({ title }) {
  return (
    <div className="empty-block">
      <Play size={18} />
      <strong>{title}</strong>
    </div>
  );
}

function IconButton({ label, icon, loading, ...props }) {
  return (
    <button className="icon-button" aria-label={label} {...props}>
      {loading ? <Loader2 className="spin" size={18} /> : icon}
    </button>
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatCompact(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) {
    return "never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatShortDay(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatAge(value) {
  if (!value) {
    return "no activity";
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 15) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return formatDateTime(value);
}

function compactText(value, length) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (text.length <= length) {
    return text || "No text captured";
  }
  return `${text.slice(0, Math.max(0, length - 3))}...`;
}

createRoot(document.getElementById("root")).render(<App />);
