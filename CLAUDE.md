# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Station Egg Hunt is a BostonHacks 2026 (Transit Gamification) hackathon app. Riders photograph small details in MBTA stations as "eggs", and other riders race a timer to find them and photograph them as proof. `README.md` has the full game rules (levels, points, timers, rotation, retiring).

## Layout and commands

An npm workspace with two packages: `backend/` (Node API + Postgres) and `frontend/` (static phone web app, no build step). Needs Node 22.9+ and Postgres 14+.

The backend's only dependency is `pg`. Use Node built-ins for everything else (`node:http`, `node:test`, `node:crypto`, global `fetch`), and ask before adding packages. The frontend has no dependencies and no build step.

```bash
npm install                                  # once, at the repo root
npm run dev                                  # backend with --watch; also serves frontend/ on :3000
npm run dev:frontend                         # frontend alone on :5173, pointed at :3000
npm test                                     # backend tests (need Postgres)
cd backend && node --test --test-name-pattern="full round" test/api.test.js   # one test
```

Env vars live in `backend/.env` (see `backend/.env.example`): `DATABASE_URL` (default `postgres://localhost:5432/egg_hunt`), `TEST_DATABASE_URL` (default `.../egg_hunt_test`), `DB_POOL_SIZE`, `CORS_ORIGINS`, `SERVE_FRONTEND`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `MBTA_API_KEY`, `PORT`. There is no linter or formatter.

## Architecture

**Scaling model.** The backend is stateless. Users, sessions, eggs, attempts, finds, reports and photos (`bytea`) all live in Postgres, so any number of instances can run behind a load balancer. The only per-instance state is caches: the station list, MBTA predictions (20s), and the housekeeping throttle. Don't add in-memory state that has to be shared across instances.

**Entry (`backend/server.js`).** The only place that reads env vars and wires in real dependencies. It runs migrations, then calls `createApp`, and handles SIGTERM.

**App (`backend/src/app.js`).** `createApp({ db, mbta, verify, geminiKey, geminiModel, now, frontendDir, corsOrigins })` returns `{ handler }`. Everything external is injected, which is how the tests control the clock and fake MBTA and Gemini.
- Routes live in a table of `[method, regex, handler, authMode]`. `authMode` is `'none'` (no token check) or `'optional'` (the bearer token is read if sent, and a bad token returns 401). Handlers that need a player call `requireUser(ctx)`. Each handler gets `ctx = { params, query, body, req, user, sessionId }` and returns plain JSON.
- To return an error, call `fail(status, message)`. The top-level handler turns it into `{ error }`. Anything else becomes a 500.
- **Time comes from the injected `now()`, never from SQL `now()`.** Pass timestamps into queries as parameters, or the clock-driven tests break.
- Photos come in as base64 data URLs in JSON (`decodeImage`), are stored in the `photos` table, and are served at `/photos/<uuid>.jpg` with an immutable cache header.
- `housekeeping()` (retiring stale eggs) runs lazily on station reads, at most once a minute per instance, measured on the injected clock. There are no background jobs.

**Auth (`backend/src/auth.js`).** Passwords are hashed with scrypt. Register and login each create a `sessions` row per device, holding a SHA-256 hash of a random 32-byte bearer token. Sessions last 30 days and slide forward on use (touched at most once an hour). Logins for unknown usernames still run scrypt against `DUMMY_HASH`, so the timing doesn't reveal which usernames exist. Usernames are unique case-insensitively (`lower(username)` index). The token never goes in a cookie, so CORS `*` is safe.

**Concurrency (`backend/src/slots.js`).** All egg-slot changes (place, rotate after a find, retire) run inside `db.tx` after `lockSlot(c, stationId, level)`, which takes a transaction-scoped Postgres advisory lock. A partial unique index also enforces one active egg per slot. `submitFind` runs the slow Gemini check *outside* any transaction, then locks and rechecks the attempt with `FOR UPDATE`. `finds (user_id, egg_id)` is unique, and `isUniqueViolation` turns a race into a 409.

**Game rules (`backend/src/game.js`).** Pure functions and constants: `LEVELS`, scoring, `monthKey` (America/New_York), timer bounds and line families. Change game balance here. `finds.month` is stored at insert time so the monthly leaderboard is a plain indexed `GROUP BY`.

**DB (`backend/src/db.js`, `backend/migrations/`).** `createDb` returns `{ query, one, many, tx, migrate, close }`. Migrations are `NNN_name.sql` files applied in order on startup under an advisory lock, and tracked in `schema_migrations`. Never edit an applied migration. Add a new file instead. Note that `count()`/`sum()` come back from pg as strings unless you cast them with `::int`.

**MBTA (`backend/src/mbta.js`).** V3 API client. Stations are fetched once and cached in `backend/data/stations.json`, which is committed. Live `/predictions` drive "race the next train", which applies only when the next train is 90–900s away.

**Verification (`backend/src/verify.js`).** Gemini compares the two photos, with a confidence threshold of 0.6. With no key, or when the call fails, it falls back to `{ method: 'honor', match: true }`.

**Frontend (`frontend/`).** Vanilla JS SPA (`app.js`) with hash routing and a global `state`. `config.js` sets `window.EGG_API_BASE` (empty means same origin), and every request and photo URL goes through `apiUrl()`. The session (`{ user, token }`) is kept in `localStorage['egg-session']`, wrapped in try/catch. On boot the app calls `/api/auth/me`, and any 401 signs this device out. It is designed for phones: camera capture, and geolocation, which needs HTTPS (use a tunnel). `serve.js` is a zero-dependency static server that rewrites `config.js` from the `API_BASE` env var.

**Tests (`backend/test/api.test.js`).** End-to-end tests over HTTP against a real Postgres. Each run creates a random `test_xxxx` schema in `TEST_DATABASE_URL` (through `search_path`), migrates it and drops it at the end. They use a fake MBTA, a controllable `nextVerify` and a mutable `clock`. `user(name)` registers and returns `{ id, username, token }`, and `call/ok(path, body, as)` sends that token. New behavior is normally tested the same way.
