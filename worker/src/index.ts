import postgres from "postgres";
import mysql from "mysql2/promise";
import { validateSupabaseCredentials } from "../../src/connectionValidation.js";

type Perms = { c: boolean; r: boolean; u: boolean; d: boolean };
const ALL: Perms = { c: true, r: true, u: true, d: true };
const NONE: Perms = { c: false, r: false, u: false, d: false };
function jwtRole(key: string): string | null {
  try {
    const p = key.split(".")[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return json.role || null;
  } catch {
    return null;
  }
}
async function probeSupabaseTable(clean: string, key: string, table: string): Promise<Perms> {
  const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const enc = encodeURIComponent(table);
  const denied = (s: number) => s === 401 || s === 403;
  const allowed = (s: number) => !denied(s);
  try {
    // R = can actually read rows. PostgREST returns 200 [] when RLS blocks everything,
    // so status alone lies. Use count=exact and check the total.
    const rRes = await fetch(`${clean}/rest/v1/${enc}?select=*&limit=1`, {
      headers: { ...H, Prefer: "count=exact" },
    });
    let r = false;
    if (allowed(rRes.status) && rRes.status !== 404) {
      const rows = await rRes.json().catch(() => []);
      // 200 [] can mean RLS-blocked OR truly empty. With REST alone we can't tell;
      // treat 0 visible rows as no read (matches "can't read" expectation).
      // Truly empty tables will show R grey too — use service_role or the list_tables RPC
      // (which returns has_table_privilege) for exact perms.
      r = Array.isArray(rows) ? rows.length > 0 : false;
    }
    // C/U/D without R are meaningless in PostgREST: an unknown-column 400 passes the
    // column check before RLS, so it lies about writes. If you can't read rows,
    // don't claim you can write them. Only count C/U/D when R holds.
    if (!r) return { c: false, r: false, u: false, d: false };
    const cRes = await fetch(`${clean}/rest/v1/${enc}`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ __lookup_probe__: 1 }),
    });
    const c = allowed(cRes.status) && cRes.status !== 404;
    const uRes = await fetch(`${clean}/rest/v1/${enc}?__lookup_probe__=eq.__none__`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ __lookup_probe__: 1 }),
    });
    const u = allowed(uRes.status) && uRes.status !== 404;
    const dRes = await fetch(`${clean}/rest/v1/${enc}?__lookup_probe__=eq.__none__`, {
      method: "DELETE",
      headers: H,
    });
    const d = allowed(dRes.status) && dRes.status !== 404;
    return { c, r, u, d };
  } catch {
    return NONE;
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
function cors() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

const CANDIDATES = [
  "users",
  "profiles",
  "posts",
  "jobs",
  "job_posting",
  "source_registry",
  "source_run",
  "ingest_task",
  "dedupe_decision",
  "canonical_opening",
  "notifications",
  "messages",
  "chats",
  "events",
  "rides",
  "payments",
  "orders",
  "products",
  "comments",
  "profiles_private",
  "ride_messages",
  "wallets",
  "transactions",
  "settings",
  "app_settings",
  "error_logs",
  "ratings",
  "applications",
  "disputes",
  "deliveries",
  "escrow",
  "badges",
  "leaderboard_entries",
  "geocode_cache",
  "cost_splits",
  "gigs",
  "companies",
  "referrals",
  "push_subscriptions",
  "event_interested_users",
  "live_transit_cache",
  "ride_reviews",
  "user_badges",
  "referral_tracking",
  "chat_messages",
  "id_verifications",
  "trips",
  "ride_links",
  "moderation_logs",
  "reports",
  "hopper_requests",
  "split_members",
  "train_info",
  "transit_schedules",
  "coins_leaderboard",
  "feedback",
  "event_ride_room_members",
  "rydin_coin_transactions",
  "Campus_locations",
  "direct_messages",
  "travel_zones",
  "hoppers",
  "settlements",
  "shuttle_timings",
  "user_verifications",
  "event_ride_rooms",
  "ride_members",
  "user_analytics",
  "vasooli_bounties",
  "chat_blocked_logs",
  "payout_queue",
  "points_transactions",
  "payout_methods",
];
const COMMON_COLS = [
  "id",
  "name",
  "title",
  "email",
  "created_at",
  "updated_at",
  "user_id",
  "status",
  "type",
  "count",
  "total",
  "description",
  "slug",
  "data",
  "payload",
];

function parseHint(text: string): string[] {
  const out = new Set<string>();
  // PGRST205: "Perhaps you meant 'public.users'?" / "'users'"
  for (const m of text.matchAll(/'public\.(\w+)'/g)) out.add(m[1]);
  for (const m of text.matchAll(/Perhaps you meant '(\w+)'/g)) out.add(m[1]);
  for (const m of text.matchAll(/Perhaps you meant the column "([^"]+)"/g)) out.add(m[1]);
  // column hints: "Perhaps you meant the column users.email"
  for (const m of text.matchAll(/Perhaps you meant the column "?([\w.]+)"?/g))
    out.add(m[1].split(".").pop()!);
  out.delete("");
  return [...out];
}

async function probeCandidates(
  clean: string,
  key: string,
  custom: string[] = [],
): Promise<string[]> {
  const all = Array.from(new Set([...CANDIDATES, ...custom]));
  const found: string[] = [];
  for (let i = 0; i < all.length; i += 6)
    await Promise.all(
      all.slice(i, i + 6).map(async (t) => {
        try {
          const r = await fetch(`${clean}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
          if (r.ok) found.push(t);
        } catch {}
      }),
    );
  return found;
}

// Technique 2: root hint — near-miss guesses get PGRST205 suggestions
async function rootHints(
  clean: string,
  key: string,
  guesses: string[],
  known: Set<string>,
): Promise<string[]> {
  const extra = new Set<string>();
  for (let i = 0; i < guesses.length; i += 6)
    await Promise.all(
      guesses.slice(i, i + 6).map(async (g) => {
        try {
          const r = await fetch(`${clean}/rest/v1/${encodeURIComponent(g)}?select=*&limit=0`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
          if (r.ok) return;
          const j: any = await r.json().catch(() => null);
          const txt = JSON.stringify(j || "") + (await r.text().catch(() => ""));
          if (j?.code === "PGRST205" || txt.includes("PGRST205")) {
            for (const s of parseHint(txt)) if (!known.has(s)) extra.add(s);
          }
        } catch {}
      }),
    );
  return [...extra];
}

// Technique 3: embedding hint — guess FK targets from a known table
async function embedHints(
  clean: string,
  key: string,
  bases: string[],
  guesses: string[],
  known: Set<string>,
): Promise<{ tables: string[]; rels: any[] }> {
  const extra = new Set<string>();
  const rels: any[] = [];
  for (const base of bases.slice(0, 8)) {
    for (let i = 0; i < guesses.length; i += 6) {
      await Promise.all(
        guesses.slice(i, i + 6).map(async (g) => {
          if (g === base) return;
          try {
            const r = await fetch(
              `${clean}/rest/v1/${encodeURIComponent(base)}?select=*,${encodeURIComponent(g)}(*)`,
              { headers: { apikey: key, Authorization: `Bearer ${key}` } },
            );
            if (r.ok) return;
            const j: any = await r.json().catch(() => null);
            const txt = JSON.stringify(j || "");
            if (j?.code === "PGRST200" || txt.includes("PGRST200")) {
              for (const s of parseHint(txt))
                if (!known.has(s)) {
                  extra.add(s);
                  rels.push({ from: `${base}.${g}`, to: s });
                }
            }
          } catch {}
        }),
      );
    }
  }
  return { tables: [...extra], rels };
}

// Techniques 4+5: column oracle via ?select=<col> and ?order=<col>
// Technique 6: grant signal — 42501 no-grant vs count=exact 0 vs >0 visible
async function grantSignal(
  clean: string,
  key: string,
  table: string,
): Promise<{ perms: Perms; signal: string; rows: number }> {
  const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    const r = await fetch(`${clean}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
      headers: { ...H, Prefer: "count=exact" },
    });
    if (!r.ok) {
      const j: any = await r.json().catch(() => null);
      if (j?.code === "42501" || String(j?.message || "").includes("permission denied"))
        return { perms: { ...NONE }, signal: "42501 no-grant", rows: 0 };
      if (r.status === 404) return { perms: { ...NONE }, signal: "404 no-table", rows: 0 };
      // retry without count header (some projects 404 on it)
      const r2 = await fetch(`${clean}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
        headers: H,
      });
      if (r2.ok) {
        const rows2: any[] = await r2.json().catch(() => []);
        return {
          perms: rows2.length ? { c: false, r: true, u: false, d: false } : { ...NONE },
          signal: rows2.length ? "visible (retry)" : "unknown",
          rows: rows2.length,
        };
      }
      return { perms: { ...NONE }, signal: `${r.status}`, rows: 0 };
    }
    const cr = r.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)\s*$/);
    const total = m ? parseInt(m[1], 10) : null;
    const rows = await r.json().catch(() => []);
    if (total !== null)
      return {
        perms: total > 0 ? { c: false, r: true, u: false, d: false } : { ...NONE },
        signal: `${total} visible`,
        rows: Array.isArray(rows) ? rows.length : 0,
      };
    return {
      perms:
        Array.isArray(rows) && rows.length > 0
          ? { c: false, r: true, u: false, d: false }
          : { ...NONE },
      signal: "visible?",
      rows: Array.isArray(rows) ? rows.length : 0,
    };
  } catch {
    return { perms: { ...NONE }, signal: "error", rows: 0 };
  }
}

// Full anon discovery — LIGHTWEIGHT (Worker-safe, ~150 subrequests max)
async function discoverAnon(
  clean: string,
  key: string,
): Promise<{ tables: any[]; relationships: any[] }> {
  const known = new Set<string>(await probeCandidates(clean, key));
  // Pass 1: root hints on candidates only (near-miss expansion, 1 batch)
  const g1 = await rootHints(clean, key, CANDIDATES.slice(0, 40), known);
  for (const t of g1) known.add(t);
  // Pass 2: embedding hints — 2 bases × 20 guesses max (was 8×70 = 560, crashed the Worker)
  const bases = [...known].slice(0, 2);
  const guesses = CANDIDATES.slice(0, 20);
  const { tables: g2, rels } = await embedHints(clean, key, bases, guesses, known);
  for (const t of g2) known.add(t);
  // Verify hinted tables (1 request each, batch 10)
  const toCheck = [...new Set([...g1, ...g2])];
  for (let i = 0; i < toCheck.length; i += 10)
    await Promise.all(
      toCheck.slice(i, i + 10).map(async (t) => {
        try {
          const r = await fetch(`${clean}/rest/v1/${encodeURIComponent(t)}?select=*&limit=0`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
          if (!(r.ok || r.status === 400 || r.status === 403)) known.delete(t);
        } catch {
          known.delete(t);
        }
      }),
    );
  const verified = [...known].slice(0, 30); // cap for Worker safety
  const tables: any[] = [];
  for (let i = 0; i < verified.length; i += 8)
    await Promise.all(
      verified.slice(i, i + 8).map(async (name) => {
        const gs = await grantSignal(clean, key, name); // 1 request: R via count
        const perms = gs.perms; // C/U/D stay false unless service_role — no false positives, no extra probes
        let columns: string[] = [];
        try {
          const rr = await fetch(`${clean}/rest/v1/${encodeURIComponent(name)}?select=*&limit=1`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
          if (rr.ok) {
            const rows: any[] = await rr.json();
            if (rows[0]) columns = Object.keys(rows[0]);
          }
        } catch {}
        // Column oracle only when no rows visible, single batch of 8 cols (not 28/table)
        if (!columns.length) {
          for (let j = 0; j < 8; j += 4)
            await Promise.all(
              COMMON_COLS.slice(j, j + 4).map(async (c) => {
                try {
                  const r = await fetch(
                    `${clean}/rest/v1/${encodeURIComponent(name)}?select=${c}&limit=0`,
                    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
                  );
                  if (r.ok) columns.push(c);
                } catch {}
              }),
            );
        }
        tables.push({
          name,
          columns: [...new Set(columns)].map((c) => ({ name: c, type: "TEXT" })),
          perms,
          signal: gs.signal,
        });
      }),
    );
  return { tables, relationships: rels };
}
async function tryRpcListTables(clean: string, key: string): Promise<any | null> {
  // If user created list_tables RPC (SQL below), anon can discover tables that way.
  for (const fn of ["list_tables", "list_all_tables"]) {
    try {
      const r = await fetch(`${clean}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (r.ok) {
        const j: any = await r.json().catch(() => null);
        if (Array.isArray(j)) return j;
        if (j && Array.isArray(j.tables)) return j.tables;
      }
    } catch {}
  }
  return null;
}
async function getSupabaseSchema(url: string, key: string) {
  const clean = url.replace(/\/$/, "");
  const res = await fetch(`${clean}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    // Anon fallback: try RPC list_tables if user created it
    const rpcTables = await tryRpcListTables(clean, key);
    if (rpcTables && rpcTables.length) {
      const tables: any[] = await Promise.all(
        rpcTables.map(async (x: any) => {
          const name = typeof x === "string" ? x : x.table_name || x.tablename || x.name;
          const rpcCols = Array.isArray(x?.columns) ? x.columns : null;
          // has_table_privilege = table-level grant; RLS policies decide actual access.
          // If RLS is on and no anon/public SELECT policy, anon reads nothing -> R=false.
          let perms: Perms;
          if (x?.anon_can_select !== undefined) {
            perms = {
              c: !!x.anon_can_insert,
              r: !!x.anon_can_select,
              u: !!x.anon_can_update,
              d: !!x.anon_can_delete,
            };
            if (x.rls_enabled) {
              const pols = Array.isArray(x.policies) ? x.policies : [];
              const hasSel = pols.some(
                (p: any) =>
                  (p.cmd === "SELECT" || p.cmd === "ALL") &&
                  JSON.stringify(p.roles || []).match(/anon|public/i),
              );
              if (!hasSel) {
                perms.r = false;
                perms.c = false;
                perms.u = false;
                perms.d = false;
              } else {
                const hasIns = pols.some(
                  (p: any) =>
                    (p.cmd === "INSERT" || p.cmd === "ALL") &&
                    JSON.stringify(p.roles || []).match(/anon|public/i),
                );
                if (!hasIns) perms.c = false;
              }
            }
          } else {
            perms =
              jwtRole(key) === "service_role"
                ? { ...ALL }
                : await probeSupabaseTable(clean, key, name);
          }
          let columns = rpcCols
            ? rpcCols.map((c: any) => ({
                name: c.name || c.column_name,
                type: (c.type || c.data_type || "TEXT").toUpperCase(),
              }))
            : [];
          if (!columns.length) {
            try {
              const rr = await fetch(
                `${clean}/rest/v1/${encodeURIComponent(name)}?select=*&limit=1`,
                { headers: { apikey: key, Authorization: `Bearer ${key}` } },
              );
              if (rr.ok) {
                const rows: any[] = await rr.json();
                if (rows[0]) columns = Object.keys(rows[0]).map((c) => ({ name: c, type: "TEXT" }));
              }
            } catch {}
          }
          return {
            name,
            columns,
            perms,
            rlsEnabled: x?.rls_enabled ?? false,
            policies: x?.policies ?? [],
          };
        }),
      );
      return { tables, relationships: [] };
    }
    if (res.status === 401 || res.status === 403) {
      // Full hint-based discovery: candidates + root hints + embedding hints + column oracle + grant signal
      const disc = await discoverAnon(clean, key);
      if (disc.tables.length) {
        return {
          tables: disc.tables,
          relationships: disc.relationships,
          note: `Anon: ${disc.tables.length} tables via OpenAPI-blocked fallback (candidates + PGRST205/PGRST200 hint expansion + column oracle). Use service_role or list_tables RPC for the full list.`,
        };
      }
      throw new Error(
        `NEEDS_SERVICE_ROLE: Supabase blocks anon keys from GET /rest/v1/. Use Service role key for full discovery. Hint discovery found nothing. Raw: ${txt}`,
      );
    }
    throw new Error(`Supabase OpenAPI ${res.status}: ${txt}`);
  }
  const spec: any = await res.json();
  const defs = spec.definitions || {};
  const tables = Object.keys(defs).map((name) => {
    const props = defs[name].properties || {};
    const cols = Object.keys(props).map((c) => ({
      name: c,
      type: (props[c].format || props[c].type || "TEXT").toUpperCase(),
      pk: name === "source_registry" && c === "source_id" ? true : false,
      fk: false,
    }));
    return { name, columns: cols, perms: ALL };
  });
  // Permissions: service_role bypasses RLS -> all allowed. Anon/authenticated -> probe each table (non-destructive).
  const role = jwtRole(key);
  if (role === "service_role") {
    for (const t of tables) t.perms = { ...ALL };
  } else if (tables.length) {
    // Probe in chunks of 6 to avoid hammering Supabase
    for (let i = 0; i < tables.length; i += 6) {
      await Promise.all(
        tables.slice(i, i + 6).map(async (t: any) => {
          t.perms = await probeSupabaseTable(clean, key, t.name);
        }),
      );
    }
  }
  // relationships: guess by _id suffix matching another table pk
  const rels: any[] = [];
  for (const t of tables)
    for (const c of t.columns)
      if (c.name.endsWith("_id") && c.name !== t.name.replace(/s$/, "") + "_id") {
        const target = tables.find((x) => x.columns.some((col) => col.name === c.name));
        if (target && target.name !== t.name)
          rels.push({ from: `${t.name}.${c.name}`, to: `${target.name}.${c.name}` });
      }
  return { tables, relationships: rels };
}

async function getPostgresSchema(cs: string) {
  const sql = postgres(cs, { max: 1, fetch_types: false });
  try {
    const rows = await sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`;
    const pks = await sql`
      SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
      WHERE tc.constraint_type='PRIMARY KEY'`;
    const fks = await sql`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY'`;
    const grants = await sql`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = current_user AND table_schema='public'`;
    const anonPerms = await sql`
      SELECT tablename, rowsecurity,
        has_table_privilege('anon', 'public.' || quote_ident(tablename), 'SELECT') AS anon_select,
        has_table_privilege('anon', 'public.' || quote_ident(tablename), 'INSERT') AS anon_insert,
        has_table_privilege('anon', 'public.' || quote_ident(tablename), 'UPDATE') AS anon_update,
        has_table_privilege('anon', 'public.' || quote_ident(tablename), 'DELETE') AS anon_delete
      FROM pg_tables WHERE schemaname='public'`;
    const policies = await sql`
      SELECT tablename, policyname, cmd, permissive, roles FROM pg_policies WHERE schemaname='public'`;
    const map = new Map<string, any>();
    for (const r of rows as any[]) {
      if (!map.has(r.table_name))
        map.set(r.table_name, { name: r.table_name, columns: [], perms: { ...NONE } });
      map.get(r.table_name).columns.push({
        name: r.column_name,
        type: String(r.data_type).toUpperCase(),
        nullable: r.is_nullable === "YES",
        pk: (pks as any[]).some(
          (p) => p.table_name === r.table_name && p.column_name === r.column_name,
        ),
        fk: (fks as any[]).some(
          (f) => f.table_name === r.table_name && f.column_name === r.column_name,
        ),
      });
    }
    for (const g of grants as any[]) {
      const t = map.get(g.table_name);
      if (!t) continue;
      const p = String(g.privilege_type).toUpperCase();
      if (p === "INSERT") t.perms.c = true;
      if (p === "SELECT") t.perms.r = true;
      if (p === "UPDATE") t.perms.u = true;
      if (p === "DELETE") t.perms.d = true;
    }
    for (const a of anonPerms as any[]) {
      const t = map.get(a.tablename);
      if (!t) continue;
      t.rlsEnabled = !!a.rowsecurity;
      t.anonPerms = {
        r: !!a.anon_select,
        c: !!a.anon_insert,
        u: !!a.anon_update,
        d: !!a.anon_delete,
      };
      t.policies = (policies as any[]).filter((p) => p.tablename === a.tablename);
    }
    return {
      tables: [...map.values()],
      relationships: (fks as any[]).map((f) => ({
        from: `${f.table_name}.${f.column_name}`,
        to: `${f.ref_table}.${f.ref_col}`,
      })),
    };
  } finally {
    await sql.end();
  }
}

async function getMysqlSchema(cfg: any) {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: Number(cfg.port || 3306),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: false,
  });
  try {
    const [cols]: any = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [cfg.database],
    );
    const [fks]: any = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [cfg.database],
    );
    const [privs]: any = await conn
      .query(
        `SELECT TABLE_NAME, PRIVILEGE_TYPE FROM INFORMATION_SCHEMA.TABLE_PRIVILEGES WHERE GRANTEE LIKE ? AND TABLE_SCHEMA=?`,
        [`%${cfg.user}%`, cfg.database],
      )
      .catch(() => [[]]);
    const map = new Map();
    for (const r of cols) {
      if (!map.has(r.TABLE_NAME))
        map.set(r.TABLE_NAME, { name: r.TABLE_NAME, columns: [], perms: { ...NONE } });
      map.get(r.TABLE_NAME).columns.push({
        name: r.COLUMN_NAME,
        type: r.COLUMN_TYPE.toUpperCase(),
        pk: r.COLUMN_KEY === "PRI",
        fk: fks.some((f: any) => f.TABLE_NAME === r.TABLE_NAME && f.COLUMN_NAME === r.COLUMN_NAME),
      });
    }
    for (const g of privs) {
      const t = map.get(g.TABLE_NAME);
      if (!t) continue;
      const p = String(g.PRIVILEGE_TYPE).toUpperCase();
      if (p === "INSERT") t.perms.c = true;
      if (p === "SELECT") t.perms.r = true;
      if (p === "UPDATE") t.perms.u = true;
      if (p === "DELETE") t.perms.d = true;
    }
    return {
      tables: [...map.values()],
      relationships: fks.map((f: any) => ({
        from: `${f.TABLE_NAME}.${f.COLUMN_NAME}`,
        to: `${f.REFERENCED_TABLE_NAME}.${f.REFERENCED_COLUMN_NAME}`,
      })),
    };
  } finally {
    await conn.end();
  }
}

const cache = new Map<string, { data: any; at: number }>();
const TTL = 60_000;
function cacheKey(pathname: string, body: any): string {
  const { type, creds, ...rest } = body;
  const ck = JSON.stringify({
    type,
    url: creds?.url,
    host: creds?.host,
    db: creds?.database,
    rest,
  });
  return pathname + "|" + ck;
}
function cached(k: string): any | null {
  const e = cache.get(k);
  if (!e || Date.now() - e.at > TTL) {
    cache.delete(k);
    return null;
  }
  return e.data;
}
function store(k: string, data: any) {
  cache.set(k, { data, at: Date.now() });
  if (cache.size > 100) cache.clear();
}

export default {
  async fetch(req: Request, env: any, _ctx: any): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors();
    if (url.pathname.startsWith("/api/")) {
      try {
        const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        const { type, ...rest } = body;
        const creds = rest.creds || rest;
        const t0 = Date.now();
        // Cache reads (schema/data/tables). Queries bypass cache.
        if (["/api/schema", "/api/data", "/api/tables"].includes(url.pathname)) {
          const ck = cacheKey(url.pathname, body);
          const hit = cached(ck);
          if (hit) return json({ ...hit, cached: true });
        }

        if (url.pathname === "/api/schema") {
          if (type === "supabase") {
            const validationError = validateSupabaseCredentials(creds);
            if (validationError) return json({ error: validationError }, 400);
          }
          const ck = cacheKey(url.pathname, body);
          let data: any;
          if (type === "supabase") data = await getSupabaseSchema(creds.url, creds.key);
          else if (type === "postgres") {
            const cs =
              creds.connectionString ||
              `postgres://${creds.user}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port || 5432}/${creds.database}?sslmode=require`;
            data = await getPostgresSchema(cs);
          } else if (type === "mysql") data = await getMysqlSchema(creds);
          else return json({ error: "Unknown type" }, 400);
          store(ck, data);
          return json(data);
        }

        if (url.pathname === "/api/tables") {
          // Manual table names (anon-key fallback): probe perms + infer columns from 1 row
          const names: string[] = Array.isArray(rest.tables) ? rest.tables : [];
          if (type !== "supabase") return json({ error: "Manual tables only for Supabase" }, 400);
          const clean = String(creds.url || "").replace(/\/$/, "");
          const tables: any[] = [];
          for (const name of names) {
            const safe = String(name)
              .trim()
              .replace(/[^a-zA-Z0-9_]/g, "");
            if (!safe) continue;
            const perms =
              jwtRole(String(creds.key || "")) === "service_role"
                ? { ...ALL }
                : await probeSupabaseTable(clean, creds.key, safe);
            let columns: any[] = [];
            try {
              const r = await fetch(
                `${clean}/rest/v1/${encodeURIComponent(safe)}?select=*&limit=1`,
                { headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` } },
              );
              if (r.ok) {
                const rows: any[] = await r.json();
                if (rows[0]) columns = Object.keys(rows[0]).map((c) => ({ name: c, type: "TEXT" }));
              }
            } catch {}
            tables.push({ name: safe, columns, perms });
          }
          store(cacheKey(url.pathname, body), { tables, relationships: [] });
          return json({ tables, relationships: [] });
        }

        if (url.pathname === "/api/data") {
          const { table, limit = 100, offset = 0, filter } = rest;
          if (type === "supabase") {
            const clean = creds.url.replace(/\/$/, "");
            let q = `${clean}/rest/v1/${encodeURIComponent(table)}?select=*&limit=${limit}&offset=${offset}`;
            if (filter) q += `&or=(${encodeURIComponent(filter)})`;
            const r = await fetch(q, {
              headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
            });
            if (!r.ok) return json({ error: await r.text() }, r.status);
            const rows = await r.json();
            return json({
              columns: rows.length ? Object.keys(rows[0]) : [],
              rows,
              total: rows.length,
              ms: Date.now() - t0,
            });
          }
          if (type === "postgres") {
            const cs =
              creds.connectionString ||
              `postgres://${creds.user}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port || 5432}/${creds.database}?sslmode=require`;
            const sql = postgres(cs, { max: 1 });
            try {
              const safe = String(table).replace(/[^a-zA-Z0-9_]/g, "");
              const rows = await sql.unsafe(
                `SELECT * FROM "${safe}" LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
              );
              return json({
                columns: rows.length ? Object.keys(rows[0]) : [],
                rows,
                total: rows.length,
                ms: Date.now() - t0,
              });
            } finally {
              await sql.end();
            }
          }
          if (type === "mysql") {
            const conn = await mysql.createConnection({
              host: creds.host,
              port: Number(creds.port || 3306),
              user: creds.user,
              password: creds.password,
              database: creds.database,
            });
            try {
              const safe = String(table).replace(/[^a-zA-Z0-9_]/g, "");
              const [rows]: any = await conn.query(`SELECT * FROM \`${safe}\` LIMIT ? OFFSET ?`, [
                Number(limit),
                Number(offset),
              ]);
              return json({
                columns: rows.length ? Object.keys(rows[0]) : [],
                rows,
                total: rows.length,
                ms: Date.now() - t0,
              });
            } finally {
              await conn.end();
            }
          }
        }

        if (url.pathname === "/api/query") {
          const sqlText = String(rest.sql || "").trim();
          if (!sqlText) return json({ error: "Empty query" }, 400);
          if (type === "supabase") {
            // Try RPC exec_sql, else PostgREST SELECT translation
            const clean = creds.url.replace(/\/$/, "");
            const m = sqlText.match(/select\s+\*\s+from\s+(\w+)(?:\s+where\s+(.+))?/i);
            if (m) {
              const tbl = m[1];
              let q = `${clean}/rest/v1/${tbl}?select=*&limit=200`;
              const r = await fetch(q, {
                headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
              });
              const rows = await r.json().catch(() => []);
              return json({
                columns: Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [],
                rows: Array.isArray(rows) ? rows : [],
                rowCount: Array.isArray(rows) ? rows.length : 0,
                ms: Date.now() - t0,
                kind: "SELECT",
                note: "Translated to PostgREST",
              });
            }
            const r = await fetch(`${clean}/rest/v1/rpc/exec_sql`, {
              method: "POST",
              headers: {
                apikey: creds.key,
                Authorization: `Bearer ${creds.key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: sqlText }),
            });
            const txt = await r.text();
            if (!r.ok)
              return json({
                error: `Supabase RPC exec_sql not available (${r.status}). ${txt}. Tip: create an exec_sql RPC or use Postgres direct connection for arbitrary SQL.`,
              });
            return json({ columns: [], rows: JSON.parse(txt || "[]"), ms: Date.now() - t0 });
          }
          if (type === "postgres") {
            const cs =
              creds.connectionString ||
              `postgres://${creds.user}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port || 5432}/${creds.database}?sslmode=require`;
            const sql = postgres(cs, { max: 1 });
            try {
              const rows = await sql.unsafe(sqlText);
              return json({
                columns: (rows as any).columns || (rows.length ? Object.keys(rows[0]) : []),
                rows,
                rowCount: (rows as any).length,
                ms: Date.now() - t0,
              });
            } finally {
              await sql.end();
            }
          }
          if (type === "mysql") {
            const conn = await mysql.createConnection({
              host: creds.host,
              port: Number(creds.port || 3306),
              user: creds.user,
              password: creds.password,
              database: creds.database,
              multipleStatements: false,
            });
            try {
              const [rows]: any = await conn.query(sqlText);
              return json({
                columns: Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [],
                rows: Array.isArray(rows) ? rows : [{ result: rows }],
                rowCount: Array.isArray(rows) ? rows.length : 1,
                ms: Date.now() - t0,
              });
            } finally {
              await conn.end();
            }
          }
        }
        return json({ error: "Not found" }, 404);
      } catch (e: any) {
        return json({ error: e?.message || String(e) }, 500);
      }
    }
    // static assets (Cloudflare Assets binding)
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Lookup - run with wrangler dev", { status: 404 });
  },
};
