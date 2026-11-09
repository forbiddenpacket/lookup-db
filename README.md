# Lookup

Lookup is a browser-based database explorer. Connect to Supabase, PostgreSQL, or MySQL through a Cloudflare Worker, or open a SQLite (`.db`) or SQL (`.sql`) file locally in your browser.

## Features

- Browse tables, columns, rows, and detected relationships.
- Explore a schema graph and run SQL queries.
- Import and export local SQLite databases and SQL files.
- Filter and sort table rows, inspect table permissions, and use saved connections.
- Connect to Supabase, PostgreSQL-compatible services, and MySQL-compatible services.

## Requirements

- Node.js 20 or newer and npm.
- A Cloudflare account to deploy the Worker.
- A database connection and credentials for hosted database features.

## Run locally

Install dependencies and start the frontend and Worker in separate terminals:

```sh
npm install
npm run dev
npm run dev:worker
```

The frontend runs at <http://localhost:5173> and proxies `/api` requests to the Worker at port 8787.

Local SQLite files are read and queried in the browser. Hosted database credentials are sent to the Worker to perform database operations. Saved connection details are kept in this browser's local storage; do not use saved connections on a shared or untrusted device.

## Checks

```sh
npm test
npm run lint
npm run format:check
npm run build
```

Use `npm run lint:fix` for safe automatic lint fixes and `npm run format` to format supported project files.

## Deploy

Update the custom-domain route in `wrangler.toml` for your Cloudflare zone, then authenticate with Wrangler and deploy:

```sh
npx wrangler login
npm run deploy
```

The deploy script builds the frontend and deploys the Worker with the generated `dist` assets. Configure database access through the app; do not commit credentials or `.env` files.

## Project structure

```text
src/             React frontend and database utilities
worker/src/      Cloudflare Worker API
wrangler.toml    Worker and static asset configuration
```
