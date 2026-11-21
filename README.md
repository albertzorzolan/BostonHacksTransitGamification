# Station Egg Hunt

BostonHacks 2026 · Transit Gamification track. Team: Jonathan & Albert.

Riders photograph small things in MBTA stations (a sticker, a tile, a mark on a bench). Other riders get the photo and a timer and have to find the real thing. You find it, take a photo to prove it and score points, then hide the next one.

## Project layout

```
frontend/   Phone web app: static HTML/JS/CSS, no build step
backend/    Node API + MongoDB (accounts, sessions, game state, photos)
api/        Vercel serverless entry that runs the backend
```

The backend keeps no state in memory between requests: users, sessions, eggs and photos all live in MongoDB. It runs as a Vercel serverless function (or as any number of plain Node servers), and players can sign in to the same account on any number of devices.

## Run it locally

Needs Node 22.9+.

```bash
npm install
cp backend/.env.example backend/.env
npm run dev                      # API + web app on http://localhost:3000
npm test                         # API tests
```

With `MONGODB_URI` empty, `npm run dev` and `npm test` start a temporary in-memory MongoDB, so you don't need to install anything. Data from `npm run dev` is lost on restart. Point `MONGODB_URI` at Atlas to keep it.

The station list comes from the MBTA API and is cached in `backend/data/stations.json`, which is committed.

## Deploy (Vercel + MongoDB Atlas)

One Vercel project serves everything. `frontend/` is served as static files, and `/api/*` and `/photos/*` are rewritten to the function in `api/index.js` (see `vercel.json`).

1. In Atlas, create a database user for this app, and under Network Access allow `0.0.0.0/0` (Vercel has no fixed IPs).
2. Set the environment variables, then deploy:
   ```bash
   npx vercel env add MONGODB_URI production     # mongodb+srv://USER:PASS@cluster.../?retryWrites=true&w=majority
   npx vercel env add GEMINI_API_KEY production  # optional
   npx vercel --prod
   ```
3. Check `https://<your-app>.vercel.app/api/health`, which returns `{"ok":true}`.

Indexes are created automatically the first time the function starts.

### Running the frontend on its own

To host `frontend/` somewhere else, set `window.EGG_API_BASE` in `frontend/config.js` to the API's URL, and add that site's origin to the backend's `CORS_ORIGINS`. For local development, `npm run dev:frontend` serves it on http://localhost:5173 and points it at `http://localhost:3000`.

### Accounts

- Players sign up with a username and password. Passwords are hashed with scrypt.
- Each sign-in creates a session for that device, using a random bearer token. The database stores only a SHA-256 hash of the token.
- A session expires after 30 days without use. Profile → "Sign out on all devices" ends every session on the account.

### Environment (`backend/.env`, or Vercel project settings)

- `MONGODB_URI`: MongoDB connection string. It must be a replica set, which Atlas always is. Required on Vercel.
- `MONGODB_DB`: database name (default `egghunt`).
- `DB_POOL_SIZE`: connections per instance (default 10).
- `CORS_ORIGINS`: allowed browser origins, comma-separated, or `*`.
- `SERVE_FRONTEND`: local server only. Set to `false` when the frontend is hosted elsewhere.
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

## Friend groups

- Any player can create a named group. The creator owns it and is the only one who can rename it.
- Every group has an 8-character invite code and a link (`/#/join/CODE`) that any member can share. Opening the link signed out goes through sign-up first, then straight to the join screen.
- Each group has its own leaderboard covering only its members, for this month or all time. Members with no points are listed unranked.
- When the owner leaves, the longest-standing member becomes the owner. The last member to leave deletes the group.
- Limits: 20 groups per player and 50 players per group. Both hold even when people join at the same moment.
- **Sticker chat:** each group has a chat for trash talk, using stickers only (no typed messages). There are 20 competitive stickers such as 👑 "Who's the king now", 🐌 "Too slow" and ⚔️ "Bring it on". Each sticker shows the sender's current rank in the group. New stickers appear within about 4 seconds (the app checks for new ones while the chat is open). The limit is 8 stickers per 10 seconds per player, and stickers are deleted after 30 days.

## Code map

- `api/index.js`: Vercel function entry
- `vercel.json`: static frontend, rewrites to the function, included data files
- `backend/server.js`: local / long-running server entry
- `backend/src/bootstrap.js`: builds the app from env vars, once per process
- `backend/src/app.js`: HTTP routes, auth middleware, CORS
- `backend/src/auth.js`: password hashing and session tokens
- `backend/src/db.js`: MongoDB client, collections, indexes, transactions
- `backend/src/slots.js`: egg slot rotation and retiring, in transactions with per-slot locks
- `backend/src/game.js`: levels, scoring, timers (pure functions)
- `backend/src/mbta.js`: MBTA V3 stations + predictions
- `backend/src/verify.js`: Gemini photo match, with honor-system fallback
- `backend/test/api.test.js`: end-to-end API tests on an in-memory MongoDB
- `frontend/`: phone web app (`config.js` sets the API URL; `serve.js` is a standalone dev server)

## Reset demo data

Drop the `egghunt` database in Atlas (or restart `npm run dev` if you're using the in-memory database). Indexes are recreated on the next start.
