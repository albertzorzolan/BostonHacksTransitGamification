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
- Every player also gets a random anonymous **chat name** (like "Sleepy Turnstile 27"), used only in group chats. Both names can be changed on the Profile tab. They share one namespace: a chat name can't match anyone's username, or your own.
- Each sign-in creates a session for that device, using a random bearer token. The database stores only a SHA-256 hash of the token.
- A session expires after 30 days without use. Profile lists every device signed in to the account, and "Sign out on all devices" ends all of those sessions.

### Environment (`backend/.env`, or Vercel project settings)

- `MONGODB_URI`: MongoDB connection string. It must be a replica set, which Atlas always is. Required on Vercel.
- `MONGODB_DB`: database name (default `egghunt`).
- `DB_POOL_SIZE`: connections per instance (default 10).
- `CORS_ORIGINS`: allowed browser origins, comma-separated, or `*`.
- `SERVE_FRONTEND`: local server only. Set to `false` when the frontend is hosted elsewhere.
- `GEMINI_API_KEY`: turns on the photo check. Without it, finds count on the honor system, and the result screen says so.
- `GEMINI_MODEL`: comma-separated models, tried in order (default `gemini-3.1-flash-lite,gemini-3-flash-preview`). A model that errors, is overloaded or takes over 15 s falls through to the next. `/api/health?gemini=1` checks the first one.
- `MBTA_API_KEY`: a free key from api-v3.mbta.com that raises the rate limit. The app works without one.

### Phones

- **Same Wi-Fi:** open the "same Wi-Fi" address the server prints. Campus Wi-Fi often blocks device-to-device traffic, so if that fails, use a tunnel.
- **Tunnel (HTTPS):** e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. HTTPS also turns on the "Near me" location button. The camera works on either.

## How it works

| Level | Points | Timer | Photo the finder sees |
|---|---|---|---|
| 1 Easy | 10 | 3 min | sharp |
| 2 Medium | 20 | 3 min | sharp |
| 3 Hard | 30 | 3 min | sharp |
| 4 Extreme | 40 | 3 min | blurred |
| 5 Impossible | 60 | 3 min | heavily blurred |

- **Blurred photos:** the server makes the blurred copy, so the sharp original's link is never sent to a finder. You see the original on the result screen once you've found it, and the photo check always compares against the original.
- **Other players' find photos** stay hidden on their profiles while that egg can still be played, unless you've found it too.

- Each station has one egg slot per level.
- **Time bonus:** up to +50% of the level's points, depending on how much of the 3 minutes is left.
- **One clock per egg:** your clock on an egg starts the first time you play it and keeps running in real time. Leaving and coming back resumes it with the time it has left; it never resets. When it runs out, or you tap "Give up", you can retry right away with a fresh clock, but a retry earns no time bonus (and doesn't count for the 30 s or Beat the train stamps), because you've already had a look around.
- **Bounty:** every player an egg beats (their clock ran out, or they gave up) adds 25% of its base points to the egg's bounty, up to 2× base. Whoever finds it takes the bounty on top of their points, and the egg's hider gets half of it. The hider is paid only when the egg is found, so an egg nobody finds earns them nothing: hide something hard but findable. After a find the bounty starts again from zero. A miss counts only if the player already had a find when they missed (so new throwaway accounts can't pump a bounty, and a first find doesn't make earlier misses count later). Each player counts once per bounty however many times they retry, and you never win a bounty built from your own misses.
- **Race the next train:** the timer becomes the minutes until the next train, from MBTA `/predictions`. It's used only when the next train is 1.5–15 minutes away; otherwise you get the level timer.
- **After a find**, the finder can hide the next egg at the same level within 30 minutes. If they skip, an older egg from that slot's pool rotates in. If the pool is empty, the found egg stays up.
- **Empty slots** can be filled by anyone, which is how you seed a station.
- **Rules:**
  - You can't play your own egg, and each egg scores once per player.
  - An egg is retired after 3 reports, or after 7 days live with no finds.
- **Leaderboard:** switch between **this month** (Boston time, resets on the 1st) and **all time**, for everyone, by station, or by line (Red / Orange / Blue / Green). Points include hiders' bounty shares. Tap a player to see their stats and recent finds.

## Map

- **Every station's egg count:** a badge in its line colour when it has eggs.
- **Faded badges:** shown once you've found (or hidden) every egg there.
- **Empty stations:** a grey "0" when zoomed in, and a small dot when zoomed out to city level, so the map stays readable.
- **Totals above the map:** eggs hidden, stations with eggs, and how many are left for you.
- **Fresh counts:** `/api/stations` returns `activeEggs` for every station and `totals`. When you're signed in, it also returns `playable`, the eggs that aren't yours and that you haven't found yet.

## Progress

- **Rider level:** grows with all-time points.
- **Daily challenge:** one per day, the same for everyone (Transfer, Beat the train, Go hard, Hat trick).
- **Stamps:** 9 of them, for things like a first find, beating the train, finding an egg in 30 seconds, finding on all 4 lines, or hiding 5 eggs.
- **Station cards:** one per station you've found eggs at.

All of it is computed from your finds, so nothing extra is stored. It's shown on the Profile tab and on each station.

## Profile

The Profile tab has your level and points, your username and anonymous chat name (both changeable), and an **activity** feed: eggs you found and hid, other players finding your eggs, groups you joined and when you signed up. Activity is private to you. Below that are today's challenge, lines, stamps, recent finds and your signed-in devices.

## Notifications

The bell at the top opens **Notifications**:
- every egg you hid, with its photo, hint, status (live, in the pool, retired) and how many times it's been found
- every time another player found one of your eggs, with the points they scored
- three counts: eggs you found, eggs you hid, and how many times others found yours

**Alerts.** A red badge on the bell counts finds you haven't seen yet. The app checks every 30 seconds while it's open. When someone finds your egg, a pop-up says who and where. When GPS puts you at a station, a pop-up says how many eggs are waiting for you there today, or asks you to hide the first one. It shows at most once per station every 30 minutes. If you tap "Turn on alerts", the same messages also arrive as browser notifications.

## Friend groups

- Any player can create a named group. The creator owns it and is the only one who can rename it.
- Every group has an 8-character invite code and a link (`/#/join/CODE`) that any member can share. Opening the link signed out goes through sign-up first, then straight to the join screen.
- Each group has its own leaderboard covering only its members, for this month or all time. Members with no points are listed unranked.
- When the owner leaves, the longest-standing member becomes the owner. The last member to leave deletes the group.
- Limits: 20 groups per player and 50 players per group. Both hold even when people join at the same moment.
- **Sticker chat:** each group has a chat for trash talk, using stickers only (no typed messages). There are 20 competitive stickers such as 👑 "Who's the king now", 🐌 "Too slow" and ⚔️ "Bring it on". The chat is anonymous: senders show only by their chat name, and messages carry no user id, so they can't be matched to the group's leaderboard. New stickers appear within about 4 seconds (the app checks for new ones while the chat is open). The limit is 8 stickers per 10 seconds per player, and stickers are deleted after 30 days.

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
