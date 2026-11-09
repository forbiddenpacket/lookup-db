import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./components/ui/dialog";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  DatabaseSchemaNode,
  DatabaseSchemaNodeHeader,
  DatabaseSchemaNodeBody,
  DatabaseSchemaTableRow,
  DatabaseSchemaTableCell,
} from "./components/database-schema-node";
import {
  Table as ShadcnTable,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableHead,
} from "./components/ui/table";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Code } from "./components/Code";
import { SqlEditor } from "./components/SqlEditor";
import { buildSchemaGraph } from "./schemaGraph.js";
import { validateSupabaseCredentials } from "./connectionValidation.js";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  executeSqliteQuery,
  exportSqliteDatabase,
  getSqliteTableRows,
  getSqliteTables,
  openSqliteFile,
} from "./sqliteDatabase.js";
import {
  Table2,
  KeyRound,
  Link2,
  Terminal,
  RefreshCw,
  Plus,
  Search,
  ListFilter,
  Loader2,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Upload,
  Download,
} from "lucide-react";

type Perms = { c: boolean; r: boolean; u: boolean; d: boolean };
type Col = { name: string; type?: string; pk?: boolean; fk?: boolean };
type Table = { name: string; columns: Col[]; perms?: Perms };
type DbType = "supabase" | "postgres" | "mysql";
type SqliteDb = InstanceType<Awaited<ReturnType<typeof initSqlJs>>["Database"]>;

let sqliteEnginePromise: ReturnType<typeof initSqlJs> | undefined;
function loadSqliteEngine() {
  sqliteEnginePromise ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  return sqliteEnginePromise;
}

const SERVICES: { id: string; label: string; backend: DbType }[] = [
  { id: "supabase", label: "Supabase", backend: "supabase" },
  { id: "postgres", label: "Postgres", backend: "postgres" },
  { id: "neon", label: "Neon", backend: "postgres" },
  { id: "mysql", label: "MySQL", backend: "mysql" },
  { id: "planetscale", label: "PlanetScale", backend: "mysql" },
  { id: "tidb", label: "TiDB", backend: "mysql" },
];

const apiCache = new Map<string, { data: any; at: number }>();
async function api(path: string, body: any) {
  const cacheable = path === "/api/data" || path === "/api/schema";
  const ck = path + JSON.stringify(body);
  if (cacheable) {
    const hit = apiCache.get(ck);
    if (hit && Date.now() - hit.at < 30_000) return hit.data;
  }
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  if (cacheable) {
    apiCache.set(ck, { data: j, at: Date.now() });
    if (apiCache.size > 50) apiCache.clear();
  }
  return j;
}

function Perms({ p }: { p?: Perms }) {
  if (!p) return null;
  const items = [
    { label: "C", name: "Create", on: p.c, onCls: "#34d399" },
    { label: "R", name: "Read", on: p.r, onCls: "#60a5fa" },
    { label: "U", name: "Update", on: p.u, onCls: "#fbbf24" },
    { label: "D", name: "Delete", on: p.d, onCls: "#fb7185" },
  ];
  return (
    <span
      className="mono shrink-0 font-bold tracking-wider"
      role="group"
      aria-label={`CRUD: ${items.map((i) => `${i.name} ${i.on ? "allowed" : "not allowed"}`).join(", ")}`}
    >
      {items.map((i) => (
        <span
          key={i.label}
          title={`${i.name}: ${i.on ? "allowed" : "not allowed"}`}
          style={{ color: i.on ? i.onCls : "#52525b" }}
        >
          {i.label}
        </span>
      ))}
    </span>
  );
}

export default function App() {
  const [service, setService] = useState("supabase");
  const svc = SERVICES.find((s) => s.id === service)!;
  const type: DbType = svc.backend;
  const [keyType, setKeyType] = useState<"anon" | "service_role">("anon");
  const [creds, setCreds] = useState<any>({});
  const [tables, setTables] = useState<Table[]>([]);
  const [rels, setRels] = useState<any[]>([]);
  const [active, setActive] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [meta, setMeta] = useState("");
  const [err, setErr] = useState("");
  const [dataErr, setDataErr] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"table" | "schema">("table");
  const [sql, setSql] = useState("SELECT * FROM source_registry LIMIT 25;");
  const [qRows, setQRows] = useState<any[] | null>(null);
  const [qCols, setQCols] = useState<string[]>([]);
  const [qMeta, setQMeta] = useState("");
  const [showSql, setShowSql] = useState(false);
  const [sqlFileName, setSqlFileName] = useState("");
  const [sqlFileMessage, setSqlFileMessage] = useState("");
  const [localDb, setLocalDb] = useState<SqliteDb | null>(null);
  const [localDbName, setLocalDbName] = useState("");
  const [rpcSql, setRpcSql] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qLoading, setQLoading] = useState(false);
  const errRef = useRef<HTMLDivElement>(null);
  const querySqlFileRef = useRef<HTMLInputElement>(null);
  const connectionSqlFileRef = useRef<HTMLInputElement>(null);

  const connected = Boolean(localDb) || tables.length > 0;
  const set = (k: string, v: string) => setCreds((c: any) => ({ ...c, [k]: v }));
  const activeTable = tables.find((t) => t.name === active);
  const filtered = tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()));
  const filteredRows = filter
    ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()))
    : rows;

  const loadTable = async (name: string, t: DbType = type, c: any = creds) => {
    setDataErr("");
    try {
      if (localDb) {
        const result = getSqliteTableRows(localDb, name);
        setRows(result.rows);
        setCols(result.columns);
        setMeta(`${result.rows.length} rows · local SQLite`);
        return;
      }
      const d = await api("/api/data", { type: t, creds: c, table: name, limit: 100, offset: 0 });
      setRows(d.rows);
      setCols(d.columns);
      setMeta(`${d.rows.length} rows · ${d.ms}ms`);
      // If rows came back, R is definitely true — override any stale grey probe
      if (d.rows.length > 0)
        setTables((prev) =>
          prev.map((tb) =>
            tb.name === name && tb.perms ? { ...tb, perms: { ...tb.perms, r: true } } : tb,
          ),
        );
    } catch (e: any) {
      let msg = String(e.message || e);
      try {
        const j = JSON.parse(msg);
        if (j.message) msg = j.message;
      } catch {}
      setDataErr(msg);
      setMeta("");
      setRows([]);
      setCols([]);
      setTimeout(() => errRef.current?.focus(), 0);
    }
  };
  const LIST_SQL = `-- Run once in Supabase SQL Editor. Then anon can list ALL tables + anon perms via RPC.
create or replace function public.list_tables()
returns table (tablename text, columns jsonb, rls_enabled boolean, anon_can_select boolean, anon_can_insert boolean, anon_can_update boolean, anon_can_delete boolean)
language sql security definer set search_path = public stable
as $$
  select t.tablename,
    (select jsonb_agg(jsonb_build_object('name', c.column_name, 'type', c.data_type) order by c.ordinal_position)
     from information_schema.columns c where c.table_schema='public' and c.table_name=t.tablename) as columns,
    t.rowsecurity as rls_enabled,
    has_table_privilege('anon', 'public.' || quote_ident(t.tablename), 'SELECT') as anon_can_select,
    has_table_privilege('anon', 'public.' || quote_ident(t.tablename), 'INSERT') as anon_can_insert,
    has_table_privilege('anon', 'public.' || quote_ident(t.tablename), 'UPDATE') as anon_can_update,
    has_table_privilege('anon', 'public.' || quote_ident(t.tablename), 'DELETE') as anon_can_delete
  from pg_tables t where t.schemaname = 'public'
  order by t.tablename;
$$;
grant execute on function public.list_tables() to anon, authenticated;`;
  const [history, setHistory] = useState<any[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("lookup-connections") || "[]");
    } catch {
      return [];
    }
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const saveHistory = (svc: string, t: DbType, c: any) => {
    const id = `${svc}|${c.url || c.host || c.connectionString || ""}|${t}`;
    const next = [
      { id, service: svc, type: t, creds: c, ts: Date.now() },
      ...history.filter((h) => h.id !== id),
    ].slice(0, 8);
    setHistory(next);
    localStorage.setItem("lookup-connections", JSON.stringify(next));
  };
  const loadHistory = (h: any) => {
    setService(h.service);
    setCreds(h.creds);
    setKeyType((h.creds?.keyType as any) || "anon");
    setDialogOpen(false);
    setTimeout(() => connectWith(h.service, h.type, h.creds), 0);
  };
  const removeHistory = (id: string) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    localStorage.setItem("lookup-connections", JSON.stringify(next));
  };
  const connectWith = async (svc: string, t: DbType, c: any) => {
    const validationError = t === "supabase" ? validateSupabaseCredentials(c) : null;
    if (validationError) {
      setErr(validationError);
      return;
    }
    setErr("");
    setRpcSql("");
    setLoading(true);
    try {
      const s = await api("/api/schema", { type: t, creds: c });
      localDb?.close();
      setLocalDb(null);
      setLocalDbName("");
      setTables(s.tables);
      setRels(s.relationships || []);
      saveHistory(svc, t, c);
      if (sqlFileName) {
        setShowSql(true);
        setDialogOpen(false);
        setSqlFileMessage(`Loaded ${sqlFileName} into Query. It has not been run.`);
      }
      if (s.tables[0]) {
        setActive(s.tables[0].name);
        loadTable(s.tables[0].name, t, c);
      }
    } catch (e: any) {
      if (String(e.message).includes("NEEDS_SERVICE_ROLE")) {
        setRpcSql(LIST_SQL);
        setErr(
          "Anon can't read information_schema / pg_policies directly. Run this once in Supabase SQL Editor, then Connect again — anon will list all tables + policies.",
        );
      } else setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  const connect = () => connectWith(service, type, creds);
  const importSqlFile = async (file?: File) => {
    if (!file) return;
    setErr("");
    setSqlFileMessage("");
    try {
      const SQL = await loadSqliteEngine();
      const { db, inferredTables } = await openSqliteFile(SQL, file);
      const nextTables = getSqliteTables(db);
      localDb?.close();
      setLocalDb(db);
      setLocalDbName(file.name.replace(/\.(sql|db)$/i, ""));
      setTables(nextTables);
      setRels([]);
      setActive(nextTables[0]?.name ?? "");
      setRows([]);
      setCols([]);
      setMeta("");
      setDataErr("");
      setErr("");
      setSqlFileName(file.name.toLowerCase().endsWith(".sql") ? file.name : "");
      setSql(
        file.name.toLowerCase().endsWith(".sql")
          ? await file.text()
          : "SELECT * FROM " + (nextTables[0]?.name ?? "") + " LIMIT 25;",
      );
      setQRows(null);
      setQCols([]);
      setQMeta("");
      setSqlFileMessage(
        inferredTables.length
          ? `Opened locally. Created ${inferredTables.length} table(s) from INSERT columns; exact types and constraints were not in the file.`
          : `Opened ${file.name} locally. Nothing was sent to a hosted database.`,
      );
      setDialogOpen(false);
      setShowSql(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not open this database file.";
      setErr(`Could not open "${file.name}": ${detail}`);
    }
  };
  const downloadSqlFile = () => {
    const blob = new Blob([sql], { type: "application/sql;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const baseName = (sqlFileName || "query.sql")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/\.sql$/i, "");
    anchor.href = url;
    anchor.download = `${baseName || "query"}.sql`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const downloadSqliteFile = () => {
    if (!localDb) return;
    const blob = new Blob([exportSqliteDatabase(localDb)], { type: "application/vnd.sqlite3" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(localDbName || "database").replace(/[^a-zA-Z0-9._-]+/g, "-")}.db`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  useEffect(() => {
    if (active) loadTable(active);
  }, [active, localDb]);
  const runQuery = async () => {
    if (!connected) {
      setQMeta("Connect a database before running SQL.");
      return;
    }
    setQMeta("Running...");
    setQLoading(true);
    try {
      if (localDb) {
        const result = executeSqliteQuery(localDb, sql);
        const nextTables = getSqliteTables(localDb);
        setTables(nextTables);
        if (active && nextTables.some((table) => table.name === active)) {
          const tableRows = getSqliteTableRows(localDb, active);
          setRows(tableRows.rows);
          setCols(tableRows.columns);
        } else if (nextTables[0]) setActive(nextTables[0].name);
        setQRows(result.rows);
        setQCols(result.columns);
        setQMeta(`${result.rows.length} rows · local SQLite`);
      } else {
        const d = await api("/api/query", { type, creds, sql });
        setQRows(d.rows);
        setQCols(d.columns || (d.rows?.[0] ? Object.keys(d.rows[0]) : []));
        setQMeta(`${d.rows?.length ?? 0} rows · ${d.ms}ms`);
      }
    } catch (e: any) {
      setQMeta(e.message);
    } finally {
      setQLoading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-50 p-3 gap-3">
      {/* Slim top bar */}
      <section
        aria-label="Connection"
        className="flex shrink-0 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-xs font-medium text-zinc-300">
            {localDb ? "SQLite file" : svc.label}
          </span>
          <span className="truncate text-zinc-400">
            {localDb
              ? `${localDbName || "Local database"} · ${tables.length} tables · only in this browser`
              : connected
                ? (creds.url || creds.host || creds.connectionString || "Connected") +
                  (tables.length ? ` · ${tables.length} tables` : "")
                : "Not connected"}
          </span>
        </span>
        {loading && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400" aria-hidden="true" />
        )}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              {connected ? "Change" : "Connect"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>{connected ? "Change connection" : "Connect"}</DialogTitle>
            <div className="grid gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-400">Database</span>
                <Select value={service} onValueChange={setService}>
                  <SelectTrigger aria-label="Database">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {type === "supabase" ? (
                <div className="grid gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Project URL
                    </span>
                    <Input
                      placeholder="https://xyz.supabase.co"
                      value={creds.url || ""}
                      onChange={(e) => set("url", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">Key type</span>
                    <Select
                      value={keyType}
                      onValueChange={(v) => {
                        setKeyType(v as any);
                        set("keyType", v);
                      }}
                    >
                      <SelectTrigger aria-label="Key type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="anon">Anon</SelectItem>
                        <SelectItem value="service_role">Service role</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      {keyType === "service_role" ? "Service role key" : "Anon key"}
                    </span>
                    <Input
                      type="password"
                      placeholder={keyType === "service_role" ? "Service role key" : "Anon key"}
                      value={creds.key || ""}
                      onChange={(e) => set("key", e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">Host</span>
                    <Input
                      placeholder="Host"
                      value={creds.host || ""}
                      onChange={(e) => set("host", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">Port</span>
                    <Input
                      placeholder={type === "postgres" ? "5432" : "3306"}
                      value={creds.port || ""}
                      onChange={(e) => set("port", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">Database</span>
                    <Input
                      placeholder="Database"
                      value={creds.database || ""}
                      onChange={(e) => set("database", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">User</span>
                    <Input
                      placeholder="User"
                      value={creds.user || ""}
                      onChange={(e) => set("user", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">Password</span>
                    <Input
                      type="password"
                      placeholder="Password"
                      value={creds.password || ""}
                      onChange={(e) => set("password", e.target.value)}
                    />
                  </label>
                  {type === "postgres" && (
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-zinc-400">
                        Connection string
                      </span>
                      <Input
                        placeholder="postgres://user:pass@host:5432/db"
                        value={creds.connectionString || ""}
                        onChange={(e) => set("connectionString", e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              <Button
                onClick={() => {
                  connect();
                }}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Connecting…
                  </>
                ) : (
                  "Connect"
                )}
              </Button>
              {err && (
                <div
                  role="alert"
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                >
                  {err}
                </div>
              )}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="flex items-center gap-3">
                  <input
                    ref={connectionSqlFileRef}
                    type="file"
                    accept=".db,.sql,application/sql,application/vnd.sqlite3,application/octet-stream,text/plain"
                    className="sr-only"
                    aria-label="Choose SQLite database or SQL file"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void importSqlFile(file);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => connectionSqlFileRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" /> Open .db / .sql
                  </Button>
                  <span className="min-w-0 truncate text-xs text-zinc-400">
                    {localDbName || "Open a local SQLite database"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Opens locally in your browser. SQL scripts build a new local database; hosted
                  databases are not changed.
                </p>
                {sqlFileMessage && (
                  <p role="status" className="mt-2 text-xs text-zinc-300">
                    {sqlFileMessage}
                  </p>
                )}
              </div>
              {history.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-zinc-400">Recent connections</p>
                  <div className="grid gap-1">
                    {history.map((h) => (
                      <div
                        key={h.id}
                        className="flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => loadHistory(h)}
                          className="min-w-0 flex-1 truncate text-left text-sm text-zinc-200 hover:text-white"
                          title={h.id}
                        >
                          {h.service} ·{" "}
                          {h.creds?.url || h.creds?.host || h.creds?.connectionString || h.id}
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeHistory(h.id)}
                          aria-label="Remove connection"
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </section>
      {err && (
        <div
          role="alert"
          tabIndex={-1}
          ref={errRef}
          className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
        >
          <b>Database error</b> — {err}
        </div>
      )}
      {rpcSql && (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-zinc-400">
              Run this once in Supabase → SQL Editor (reads information_schema + pg_policies):
            </p>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigator.clipboard.writeText(rpcSql).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "Copied" : "Copy SQL"}
            </Button>
          </div>
          <div className="mt-2 max-h-56 overflow-auto rounded bg-black">
            <Code code={rpcSql} lang="sql" />
          </div>
        </div>
      )}

      {/* 2-pane */}
      <div className="flex flex-1 min-h-0 items-stretch">
        <aside
          aria-label="Tables"
          className="flex w-80 shrink-0 flex-col overflow-hidden rounded-l-xl border border-zinc-800 bg-zinc-900"
        >
          <div className="p-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                aria-hidden="true"
              />
              <Input
                aria-label="Search tables"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 pb-3">
            <Button variant="outline" size="sm">
              <ListFilter /> Filters
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView(view === "schema" ? "table" : "schema")}
              aria-label="Toggle schema diagram"
            >
              Schema
            </Button>
            <Button variant="outline" size="sm" onClick={connect} aria-label="Refresh tables">
              <RefreshCw />
            </Button>
            <Button variant="outline" size="sm" aria-label="New table">
              <Plus /> New
            </Button>
          </div>
          <nav aria-label="Table list" className="flex-1 overflow-auto p-2" aria-busy={loading}>
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading tables…
              </div>
            )}
            {!loading && !connected && (
              <div className="grid place-items-center px-4 py-10 text-center">
                <p className="text-sm font-medium text-zinc-300">No tables yet</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {localDb
                    ? "This file does not contain any tables."
                    : "Connect to a database or open a local .db / .sql file."}
                </p>
              </div>
            )}
            {filtered.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => {
                  setActive(t.name);
                  setView("table");
                }}
                aria-current={t.name === active ? "true" : undefined}
                className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                style={{ background: t.name === active ? "#27272a" : "transparent" }}
              >
                <Table2 className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                <span title={t.name} className="min-w-0 flex-1 overflow-hidden text-ellipsis">
                  {t.name}
                </span>
                <Perms p={t.perms} />
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-3 text-xs text-zinc-500">
            <span role="status" aria-atomic="true" className="flex-1">
              {tables.length} tables
            </span>
          </div>
        </aside>

        <main
          aria-label="Table data"
          className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-r-xl border border-l-0 border-zinc-800 bg-zinc-900"
        >
          {localDb && tables.length === 0 ? (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div>
                <p className="font-medium">No tables found in this file</p>
                <p className="mt-1 max-w-md text-sm text-zinc-400">
                  Open a SQLite .db that contains tables, or import a .sql file with CREATE TABLE
                  statements or INSERT statements that include column names.
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowSql(true)}
                >
                  <Terminal className="h-4 w-4" /> Open SQL editor
                </Button>
              </div>
            </div>
          ) : !connected ? (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div>
                <p className="font-medium">No connection</p>
                <p className="mt-1 text-sm text-zinc-400">
                  Pick a database above, enter credentials, then Connect.
                </p>
              </div>
            </div>
          ) : view === "table" ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 p-2">
                <Button variant="outline" size="sm" onClick={() => loadTable(active)}>
                  <RefreshCw /> Reload
                </Button>
                <Input
                  aria-label="Search rows"
                  placeholder="Search rows…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="max-w-64"
                />
                {filter && (
                  <Badge className="bg-zinc-800 text-zinc-300">{filteredRows.length} matches</Badge>
                )}
                <div className="flex-1" />
                <Button
                  variant={showSql ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowSql((s) => !s)}
                  aria-expanded={showSql}
                  aria-label="Toggle SQL query panel"
                >
                  <Terminal /> Query
                </Button>
                <span className="text-xs text-zinc-400" role="status" aria-atomic="true">
                  {meta}
                </span>
              </div>
              {dataErr && (
                <div
                  role="alert"
                  tabIndex={-1}
                  ref={errRef}
                  className="m-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                >
                  <b>Couldn't load rows</b> — {dataErr}
                </div>
              )}
              <div className="flex-1 overflow-auto">
                <DataGrid rows={filteredRows} cols={cols} activeTable={activeTable} />
              </div>
            </>
          ) : (
            <SchemaFlow tables={tables} rels={rels} />
          )}
        </main>
      </div>

      {showSql && (connected || Boolean(sqlFileName)) && (
        <div className="fixed bottom-4 left-1/2 z-20 flex max-h-[calc(100dvh-2rem)] w-[min(920px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.72),0_6px_20px_rgba(0,0,0,0.5)]">
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-zinc-400">
            <Terminal className="h-4 w-4" aria-hidden="true" />
            <span>SQL Query</span>
            <span className="text-xs">⌘/Ctrl+Enter to run</span>
            <div className="flex-1" />
            <input
              ref={querySqlFileRef}
              type="file"
              accept=".db,.sql,application/sql,application/vnd.sqlite3,application/octet-stream,text/plain"
              className="sr-only"
              aria-label="Choose SQLite database or SQL file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void importSqlFile(file);
              }}
            />
            <Button variant="outline" size="sm" onClick={() => querySqlFileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Open .db / .sql
            </Button>
            <Button variant="outline" size="sm" onClick={downloadSqlFile} disabled={!sql.trim()}>
              <Download className="h-4 w-4" /> Download .sql
            </Button>
            {localDb && (
              <Button variant="outline" size="sm" onClick={downloadSqliteFile}>
                <Download className="h-4 w-4" /> Download .db
              </Button>
            )}
            <span role="status" aria-atomic="true" className="text-xs">
              {qMeta}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSql(false)}
              aria-label="Close SQL query panel"
            >
              ✕
            </Button>
          </div>
          {(sqlFileName || sqlFileMessage) && (
            <div role="status" className="mt-1 shrink-0 truncate text-xs text-zinc-500">
              {sqlFileMessage || `Editing ${sqlFileName}`}
            </div>
          )}
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <SqlEditor value={sql} onChange={setSql} onRun={runQuery} />
            {qRows && (
              <div className="mt-2 max-h-64 min-w-0 overflow-auto rounded-md border border-zinc-800">
                <DataGrid rows={qRows} cols={qCols} compact />
              </div>
            )}
          </div>
          <div className="mt-2 flex shrink-0 gap-2">
            <Button size="sm" onClick={runQuery} disabled={!connected || qLoading}>
              {qLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Running…
                </>
              ) : (
                "Run"
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSql(sql.replace(/\s+/g, " ").replace(/;/g, ";\n").trim())}
            >
              Format
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DataGrid({
  rows,
  cols,
  activeTable,
  compact = false,
}: {
  rows: any[];
  cols: string[];
  activeTable?: Table;
  compact?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: compact ? 10 : 25 });
  const columns = useMemo<ColumnDef<any>[]>(
    () =>
      cols.map((name) => {
        const schemaColumn = activeTable?.columns.find((column) => column.name === name);
        return {
          id: name,
          accessorFn: (row) => row[name],
          sortingFn: "alphanumeric",
          header: ({ column }) => {
            const sortIcon = !column.getIsSorted() ? (
              <ArrowUpDown className="h-3 w-3 text-zinc-500" aria-hidden="true" />
            ) : column.getIsSorted() === "asc" ? (
              <ArrowUp className="h-3 w-3 text-emerald-400" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3 text-emerald-400" aria-hidden="true" />
            );
            return (
              <button
                type="button"
                onClick={column.getToggleSortingHandler()}
                className="group inline-flex max-w-full items-center gap-2 text-left font-medium text-zinc-300 hover:text-white"
              >
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  {schemaColumn?.pk && (
                    <KeyRound className="h-3.5 w-3.5 text-amber-400" aria-label="Primary key" />
                  )}
                  {schemaColumn?.fk && (
                    <Link2 className="h-3.5 w-3.5 text-sky-400" aria-label="Foreign key" />
                  )}
                  {name}
                </span>
                {sortIcon}
              </button>
            );
          },
          cell: ({ getValue }) => {
            const value = getValue();
            const text =
              value === null || value === undefined
                ? "NULL"
                : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value);
            if (value === null || value === undefined)
              return <span className="font-mono text-xs text-zinc-600">NULL</span>;
            return (
              <span
                className={`block max-w-[24rem] truncate ${typeof value === "number" ? "font-mono tabular-nums text-sky-300" : "text-zinc-200"}`}
                title={text}
              >
                {text}
              </span>
            );
          },
          meta: { isKey: Boolean(schemaColumn?.pk) },
        };
      }),
    [cols, activeTable],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  });
  const pageRows = table.getRowModel().rows;
  const pageCount = Math.max(1, table.getPageCount());
  const start = rows.length ? pagination.pageIndex * pagination.pageSize + 1 : 0;
  const end = Math.min(start + pageRows.length - 1, rows.length);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="min-w-0 flex-1 overflow-auto">
        <ShadcnTable className="w-max min-w-full border-separate border-spacing-0">
          <TableHeader className="sticky top-0 z-10 bg-zinc-900 [&_tr]:border-0">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-zinc-900 hover:bg-zinc-900">
                <TableHead className="sticky left-0 z-20 w-12 min-w-12 border-b border-zinc-700 bg-zinc-900 px-3 text-right text-xs text-zinc-500">
                  #
                </TableHead>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="min-w-40 max-w-72 border-b border-zinc-700 bg-zinc-900 px-3 py-3 text-xs uppercase tracking-wide text-zinc-400"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {pageRows.map((row, index) => (
              <TableRow
                key={row.id}
                className="h-11 border-zinc-800 bg-zinc-950 hover:bg-zinc-900/80"
              >
                <TableCell className="sticky left-0 z-[1] border-b border-zinc-800 bg-zinc-950 px-3 text-right font-mono text-xs tabular-nums text-zinc-600">
                  {start + index}
                </TableCell>
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className="max-w-72 border-b border-zinc-800 px-3 py-2.5 text-sm"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {pageRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={cols.length + 1}
                  className="h-28 text-center text-sm text-zinc-500"
                >
                  No rows to display.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </ShadcnTable>
      </div>
      <div
        className={`flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-400 ${compact ? "py-2" : "py-2.5"}`}
      >
        <span className="tabular-nums">
          {start}–{end} of {rows.length} rows
        </span>
        <label className="flex items-center gap-2">
          Rows
          <select
            aria-label="Rows per page"
            value={pagination.pageSize}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
            className="h-7 rounded border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto tabular-nums">
          Page {table.getState().pagination.pageIndex + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function SchemaFlow({ tables, rels }: { tables: Table[]; rels: any[] }) {
  const { nodes, edges } = useMemo(() => {
    return buildSchemaGraph(tables, rels) as { nodes: Node[]; edges: Edge[] };
  }, [tables, rels]);
  return (
    <div className="flex-1" style={{ minHeight: 420 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ databaseSchemaNode: DatabaseSchemaNodeFlow } as any}
        colorMode="dark"
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function DatabaseSchemaNodeFlow({ data }: any) {
  const t: Table = data.table;
  const accentColor = data.accentColor || "#71717a";
  // Handle decorations live in each field row, matching edge IDs produced by buildSchemaGraph.
  return (
    <DatabaseSchemaNode
      className="w-[340px] overflow-visible border bg-zinc-950 text-zinc-100 shadow-xl"
      style={{ borderColor: accentColor }}
    >
      <DatabaseSchemaNodeHeader>
        <span className="flex items-center gap-2 text-left font-mono font-semibold text-zinc-100">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: accentColor }}
            aria-hidden="true"
          />
          {t.name}
        </span>
      </DatabaseSchemaNodeHeader>
      <DatabaseSchemaNodeBody>
        {t.columns.map((c: Col) => (
          <DatabaseSchemaTableRow
            key={c.name}
            className="h-9 border-t border-zinc-800 bg-zinc-950 hover:bg-zinc-900"
          >
            <DatabaseSchemaTableCell className="relative py-1.5 pl-3 pr-2">
              <span className="flex items-center gap-2 font-mono text-xs">
                {c.pk ? (
                  <KeyRound
                    className="h-3.5 w-3.5 shrink-0 text-amber-400"
                    aria-label="Primary key"
                  />
                ) : c.fk ? (
                  <Link2
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: accentColor }}
                    aria-label="Foreign key"
                  />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="text-zinc-200">{c.name}</span>
              </span>
              {data.targetColumns?.includes(c.name) && (
                <Handle
                  id={`${t.name}.${c.name}.target`}
                  type="target"
                  position={Position.Left}
                  className="!h-2.5 !w-2.5 !border-2 !border-zinc-950"
                  style={{ backgroundColor: accentColor }}
                />
              )}
            </DatabaseSchemaTableCell>
            <DatabaseSchemaTableCell className="py-1.5 pr-3 text-right font-mono text-[11px] text-zinc-500">
              {c.type || ""}
            </DatabaseSchemaTableCell>
            {data.sourceColumns?.includes(c.name) && (
              <Handle
                id={`${t.name}.${c.name}.source`}
                type="source"
                position={Position.Right}
                className="!h-2.5 !w-2.5 !border-2 !border-zinc-950"
                style={{ backgroundColor: accentColor }}
              />
            )}
          </DatabaseSchemaTableRow>
        ))}
      </DatabaseSchemaNodeBody>
    </DatabaseSchemaNode>
  );
}
