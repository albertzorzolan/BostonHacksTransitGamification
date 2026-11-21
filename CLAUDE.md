# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Station Egg Hunt is a BostonHacks 2026 (Transit Gamification) hackathon app. Riders photograph small details in MBTA stations as "eggs", and other riders race a timer to find them and photograph them as proof. `README.md` has the full game rules (levels, points, timers, rotation, retiring).

## Layout and commands

An npm workspace: `backend/` (Node API + MongoDB) and `frontend/` (static phone web app, no build step), plus `api/index.js` and `vercel.json` for deploying both as one Vercel project. Needs Node 22.9+.

The backend's only runtime dependency is `mongodb`, and `mongodb-memory-server` is a dev dependency. Use Node built-ins for everything else (`node:http`, `node:test`, `node:crypto`, global `fetch`), and ask before adding packages. The frontend has no dependencies and no build step.

```bash
npm install                                  # once, at the repo root
npm run dev                                  # local server with --watch; also serves frontend/ on :3000
npm run dev:frontend                         # frontend alone on :5173, pointed at :3000
npm test                                     # backend tests (in-memory MongoDB, nothing to install)
cd backend && node --test --test-name-pattern="full round" test/api.test.js   # one test
npx vercel --prod                            # deploy (project is CLI-deployed, not git-connected)
```

Env vars live in `backend/.env` locally (see `backend/.env.example`) and in Vercel project settings in production: `MONGODB_URI` (empty means a temporary in-memory MongoDB locally, and it is required on Vercel), `MONGODB_DB` (default `egghunt`), `TEST_MONGODB_URI`, `DB_POOL_SIZE`, `CORS_ORIGINS`, `SERVE_FRONTEND`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `MBTA_API_KEY`, `PORT`. There is no linter or formatter.

## Architecture

**Deployment.** On Vercel, `frontend/` is the static output directory, and `/api/*` and `/photos/*` are rewritten to `api/index.js`, which calls `getApp()` from `backend/src/bootstrap.js` and passes `(req, res)` to `app.handler`. Locally, `backend/server.js` uses the same `getApp()` behind `node:http`. `bootstrap.js` is the only place that reads env vars. It builds the app once per process and caches it, so a warm function reuses its Mongo pool. Vercel limits request bodies to 4.5 MB, so `MAX_BODY_BYTES` is 4 MB. The phone downscales photos to about 0.3 MB.

**Scaling model.** The backend is stateless. Users, sessions, eggs, attempts, finds, reports and photos (stored as binary) all live in MongoDB. The only per-instance state is caches: the station list, MBTA predictions (20s), and the housekeeping throttle. Don't add in-memory state that has to be shared across instances.

**App (`backend/src/app.js`).** `createApp({ db, mbta, verify, geminiKey, geminiModel, now, frontendDir, corsOrigins })` returns `{ handler }`. Everything external is injected, which is how the tests control the clock and fake MBTA and Gemini.
- Routes live in a table of `[method, regex, handler, authMode]`. `authMode` is `'none'` (no token check) or `'optional'` (the bearer token is read if sent, and a bad token returns 401). Handlers that need a player call `requireUser(ctx)`. Each handler gets `ctx = { params, query, body, req, user, sessionId }` and returns plain JSON.
- To return an error, call `fail(status, message)`. The top-level handler turns it into `{ error }`. Anything else becomes a 500.
- **Time comes from the injected `now()`.** Store and compare JS `Date`s from it, and never use `$$NOW` or `new Date()` directly, or the clock-driven tests break.
- Documents use UUID strings as `_id`, and fields are camelCase. The API returns `id`, not `_id`.
- Photos come in as base64 data URLs in JSON (`decodeImage`), are stored in `photos`, and are served at `/photos/<uuid>.jpg` with an immutable cache header. Read them with `{ promoteBuffers: true }` to get a `Buffer`.
- `housekeeping()` (retiring stale eggs) runs lazily on station reads, at most once a minute per instance, measured on the injected clock. There are no background jobs.

**Auth (`backend/src/auth.js`).** Passwords are hashed with scrypt. Register and login each create a `sessions` document per device, holding a SHA-256 hex hash of a random 32-byte bearer token. Sessions last 30 days and slide forward on use (touched at most once an hour), and a TTL index on `expiresAt` deletes them. Logins for unknown usernames still run scrypt against `DUMMY_HASH`. Usernames are unique through `usernameLower`. The token never goes in a cookie, so CORS `*` is safe.

**Concurrency (`backend/src/slots.js`, `db.tx`).** All egg-slot changes (place, rotate after a find, retire) run inside `db.tx(fn)`, a MongoDB transaction through `session.withTransaction`, after `lockSlot()`, which `$inc`s a per-slot document in `locks`. Two transactions on the same slot then write-conflict, and the driver retries the loser. `withTransaction` may run `fn` more than once, so `fn` must only touch the database (no Gemini or MBTA calls), and every query inside it must pass `{ session }`. A partial unique index also enforces one active egg per slot. `submitFind` runs the slow Gemini check *outside* the transaction, then closes the round atomically with `findOneAndUpdate({ status: 'open' })`. `finds {userId, eggId}` is unique, and `isDuplicateKey` turns a race into a 409. Transactions need a replica set: Atlas always is one, and the in-memory server is started as one.

**DB (`backend/src/db.js`).** `createDb({ uri, dbName })` connects, creates all indexes (idempotent, on every start) and returns `{ client, db, col, tx, close }`, where `col.<name>` is each collection. `startMemoryMongo()` starts mongodb-memory-server, pinned to mongod 7.0.14 (`MONGOMS_VERSION` overrides it). Add new collections and indexes to `createDb`.

**Game rules (`backend/src/game.js`).** Pure functions and constants: `LEVELS`, scoring, `monthKey` (America/New_York), timer bounds and line families. Change game balance here. `finds.month` is stored at insert time so the monthly leaderboard is an indexed `$group`.

**MBTA (`backend/src/mbta.js`).** V3 API client. Stations are fetched once and cached in `backend/data/stations.json`, which is committed and included in the Vercel function through `includeFiles`. Live `/predictions` drive "race the next train", which applies only when the next train is 90–900s away.

**Verification (`backend/src/verify.js`).** Gemini compares the two photos, with a confidence threshold of 0.6. With no key, or when the call fails, it falls back to `{ method: 'honor', match: true }`.

**Frontend (`frontend/`).** Vanilla JS SPA (`app.js`) with hash routing and a global `state`. `config.js` sets `window.EGG_API_BASE` (empty means same origin, as on Vercel), and every request and photo URL goes through `apiUrl()`. The session (`{ user, token }`) is kept in `localStorage['egg-session']`, wrapped in try/catch. On boot the app calls `/api/auth/me`, and any 401 signs this device out. It is designed for phones: camera capture, and geolocation, which needs HTTPS. `serve.js` is a zero-dependency static server that rewrites `config.js` from the `API_BASE` env var.

**Tests (`backend/test/api.test.js`).** End-to-end tests over HTTP against a real MongoDB: an in-memory replica set, or `TEST_MONGODB_URI` with a random database that is dropped afterwards. They use a fake MBTA, a controllable `nextVerify` and a mutable `clock`. `user(name)` registers and returns `{ id, username, token }`, and `call/ok(path, body, as)` sends that token. `db.col.*` is available for asserting on stored documents. New behavior is normally tested the same way.
