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
- A session expires after 30 days without use. Profile lists every device signed in to the account, and "Sign out on all devices" ends all of those sessions.

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
- **Tunnel (HTTPS):** e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. Browsers only share location over HTTPS (or on localhost), so the app can find your station by itself only over a tunnel. On plain Wi-Fi, players pick their station from the list. The camera works on either.

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
- **Leaderboard:** this month (Boston time), for everyone or for one station. The everyone view also shows the line war (each find scores for every line at its station, so a Park Street find counts for Red and Green) and the player just above you. Tap a player to see their stats, finds by level and recent finds.
- **Lookout layer:** rider level from all-time points, one daily challenge, stamps, a card per station (clear all four levels), and the HUD's rank and points. "Transfer" (stamp and challenge) needs finds at two different stations on different lines in one day: finds at a single two-line station like Park Street count as one line.

### A round in real life

Players open the app at a station, search, close the app, ride a train and open it again somewhere else. The round is built for that:

- **The server keeps the clock.** A round's deadline is set when it starts and keeps running while the app is closed, the screen is off or there's no signal. The phone saves the round too (`localStorage`), and on opening, coming back to the tab or getting signal back, it asks `GET /api/me/active` what is still running. Opening the app mid-round goes straight back to the clock ("Welcome back. The clock kept running while you were away."). Off the play screen, a "Round running" banner and a Resume button on the egg count down.
- **Starting the same egg again resumes it.** `POST /api/attempts` returns the round that's already running instead of restarting the timer.
- **Giving up or running out starts a 60-minute cooldown on that egg** (`RETRY_COOLDOWN_MINUTES` in `game.js`), so give up and restart can't be used to see the photo again with a fresh clock. Giving up is `POST /api/attempts/:id/give-up`. With no signal, the phone keeps it and sends it on the next sync.
- **Photos survive bad signal.** The photo is kept on the phone until the server has it. If sending fails, "Send this photo again" retries, and an unsent photo goes by itself the next time the round opens. Upload time doesn't count: the server judges a find by when the request arrived, and the play screen won't call time's up while a photo is sending. Sending the same find twice (a retry after the reply was lost) returns the saved result instead of an error.
- **The right to hide the next egg survives closing the app.** For 30 minutes after a find, station screens show "Hide the next egg at …" with Hide it and Skip. `GET /api/me/active` also lists these.
- **Location after a ride.** Phones hand back the last known position for a while, which after a ride is the previous station. Positions older than the moment the app was put away are ignored, and Here waits for a fresh one. Underground, where there often isn't one, it offers "Still at <last station>?" and the station list. Once you're at a station, GPS wobble doesn't flip it to a neighbour. "Not this station? Pick yours" fixes a wrong guess, and Here sticks to the station you pick until you've been away.
- **The screen stays on during a round** (Wake Lock API, where supported). A red bar says when there's no signal, and screens that failed to load reload by themselves when it's back.

## Code map

- `backend/server.js`: entry point that reads env vars, runs migrations and starts the server
- `backend/src/app.js`: HTTP routes, auth middleware, CORS
- `backend/src/auth.js`: password hashing and session tokens
- `backend/src/db.js`: Postgres pool, transactions, migration runner
- `backend/src/slots.js`: egg slot rotation and retiring, in SQL with per-slot locks
- `backend/src/game.js`: levels, scoring, timers (pure functions)
- `backend/src/mbta.js`: MBTA V3 stations + predictions
- `backend/src/verify.js`: Gemini photo match, with honor-system fallback
- `backend/migrations/`: SQL schema, applied in order on startup (`002_rounds.sql` adds given-up rounds and `ended_at` for the retry cooldown)
- `backend/test/api.test.js`: end-to-end API tests (each run uses a throwaway Postgres schema)
- `frontend/`: phone web app (`config.js` sets the API URL; `serve.js` is a standalone dev server)

## Reset demo data

```bash
dropdb egg_hunt && createdb egg_hunt   # tables are recreated on the next start
```
