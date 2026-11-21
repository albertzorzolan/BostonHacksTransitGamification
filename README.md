# Station Egg Hunt

BostonHacks 2026 · Transit Gamification track. Team: Jonathan & Albert.

Riders photograph small things in MBTA stations (a sticker, a tile, a mark on a bench). Other riders get the photo and a timer and have to find the real thing. You find it, take a photo to prove it and score points, then hide the next one.

## Project layout

```
backend/    Node API + Postgres (accounts, sessions, game state, photos)
frontend/   Phone web app: static HTML/JS/CSS, no build step
```

The backend keeps no state in memory between requests: users, sessions, eggs and photos all live in Postgres. You can run as many backend instances as you like behind a load balancer, and players can sign in to the same account on any number of devices.

## Run it

Needs Node 22.9+ and Postgres 14+.

```bash
npm install                      # installs the backend's one dependency (pg)
createdb egg_hunt                # the tables are created on first start
createdb egg_hunt_test           # used by npm test
cp backend/.env.example backend/.env

npm run dev                      # API + web app on http://localhost:3000
npm test                         # API tests against Postgres
```

The first start downloads the station list from the MBTA API and caches it in `backend/data/stations.json`.

### Running the frontend on its own

By default the backend also serves `frontend/`, so phones need only one URL. To host the frontend separately (Vercel, Netlify, S3, any static host):

- Set `window.EGG_API_BASE` in `frontend/config.js` to the API's URL.
- Set `CORS_ORIGINS` on the backend to the frontend's origin, and `SERVE_FRONTEND=false`.
- For local development: `npm run dev:frontend` serves it on http://localhost:5173 and points it at `http://localhost:3000`.

### Accounts

- Players sign up with a username and password. Passwords are hashed with scrypt.
- Each sign-in creates a session for that device, using a random bearer token. The database stores only a SHA-256 hash of the token.
- A session expires after 30 days without use. Profile → "Sign out on all devices" ends every session on the account.

### Environment (`backend/.env`)

- `DATABASE_URL`: Postgres connection string. Any managed Postgres works (Neon, Supabase, RDS).
- `DB_POOL_SIZE`: connections per instance (default 10).
- `CORS_ORIGINS`: allowed browser origins, comma-separated, or `*`.
- `SERVE_FRONTEND`: set to `false` when the frontend is hosted elsewhere.
- `GEMINI_API_KEY`: turns on the photo check. Without it, finds count on the honor system, and the result screen says so.
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`. Change it if Google has retired that model.
- `MBTA_API_KEY`: a free key from api-v3.mbta.com that raises the rate limit. The app works without one.

### Phones

- **Same Wi-Fi:** open the "same Wi-Fi" address the server prints. Campus Wi-Fi often blocks device-to-device traffic, so if that fails, use a tunnel.
- **Tunnel (HTTPS):** e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. HTTPS also turns on the "Near me" location button. The camera works on either.

## How it works

| Level | Points | Timer |
|---|---|---|
| 1 Easy | 10 | 2 min |
| 2 Medium | 20 | 3 min |
| 3 Hard | 30 | 4 min |
| 4 Extreme | 40 | 5 min |
| 5 Impossible | 60 | 6 min |

- Each station has one egg slot per level.
- **Time bonus:** up to +50% of the level's points, depending on how much time is left.
- **Race the next train:** the timer becomes the minutes until the next train, from MBTA `/predictions`. It's used only when the next train is 1.5–15 minutes away; otherwise you get the level timer.
- **After a find**, the finder can hide the next egg at the same level within 30 minutes. If they skip, an older egg from that slot's pool rotates in. If the pool is empty, the found egg stays up.
- **Empty slots** can be filled by anyone, which is how you seed a station.
- **Rules:**
  - You can't play your own egg, and each egg scores once per player.
  - An egg is retired after 3 reports, or after 7 days live with no finds.
- **Leaderboard:** this month (Boston time) for everyone, by station, or by line (Red / Orange / Blue / Green).

## Code map

- `backend/server.js`: entry point that reads env vars, runs migrations and starts the server
- `backend/src/app.js`: HTTP routes, auth middleware, CORS
- `backend/src/auth.js`: password hashing and session tokens
- `backend/src/db.js`: Postgres pool, transactions, migration runner
- `backend/src/slots.js`: egg slot rotation and retiring, in SQL with per-slot locks
- `backend/src/game.js`: levels, scoring, timers (pure functions)
- `backend/src/mbta.js`: MBTA V3 stations + predictions
- `backend/src/verify.js`: Gemini photo match, with honor-system fallback
- `backend/migrations/`: SQL schema, applied in order on startup
- `backend/test/api.test.js`: end-to-end API tests (each run uses a throwaway Postgres schema)
- `frontend/`: phone web app (`config.js` sets the API URL; `serve.js` is a standalone dev server)

## Reset demo data

```bash
dropdb egg_hunt && createdb egg_hunt   # tables are recreated on the next start
```
