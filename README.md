# Lookup — DB Browser (Astryx + Cloudflare Workers)

Real DB browser, no demo data. Pick Supabase / Postgres / MySQL, enter creds, browse tables + run SQL. All DB access happens in the Worker backend (`/api/*`), never in the browser.

## UI — Astryx (Meta design system)
- React 19 + `@astryxdesign/core` + `@astryxdesign/theme-gothic` (dark-only) + Tailwind v4 token bridge
- No header, no tabs. Just: connection bar → 2-pane (table list with C/R/U/D badges + live grid) → floating SQL dock bottom-center
- Sidebar matches your screenshot: Search, Filters, ⛉ schema toggle, ↻ refresh, + New
- Grid matches your screenshot: row numbers, 🔑/🔗 column markers, blue numbers, grey NULL, toolbar with Add/Delete row + `eg: id = 10` filter + Applied
- Schema view: dotted canvas, one card per table + Relationships

## Supabase (URL + anon/service key)
- Schema: PostgREST OpenAPI (`/rest/v1/`) → all tables + columns visible in sidebar
- Perms per table: `service_role` = all green (bypasses RLS). `anon`/`authenticated` = probed non-destructively (impossible filter + unknown column) → C/R/U/D badges, grey/neutral = not allowed, Add/Delete disabled accordingly
- Data: `GET /rest/v1/{table}?select=*`
- Query: `SELECT * FROM x` translated to PostgREST; arbitrary SQL via `rpc/exec_sql` if you create it, else use Postgres type with direct connection string

## Postgres / MySQL
- Real `information_schema` introspection (tables, columns, PK/FK, grants → C/R/U/D)

## Run
```bash
npm install
npm run dev          # Vite http://localhost:5173 (proxies /api → :8787)
npm run dev:worker   # Wrangler http://localhost:8787
npm run deploy       # vite build + wrangler deploy
```

## Docs for Astryx
```bash
npm run astryx -- component Button
npm run astryx -- template --list
```
