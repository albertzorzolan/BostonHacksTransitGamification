# Station Egg Hunt

BostonHacks 2026 · Transit Gamification track. Team: Jonathan & Albert.

Riders photograph small things in MBTA stations (a sticker, a tile, a mark on a bench). Other riders get the photo and a timer and have to find the real thing. You find it, take a photo to prove it and score points, then hide the next one.

## Run it

Needs Node 22.9+ and no `npm install` (no dependencies).

```bash
npm start          # http://localhost:3000
npm run dev        # same, restarts on file changes
npm test           # API + game-rule tests
```

The first start downloads the station list from the MBTA API and caches it in `data/stations.json`.

### Optional keys (`.env`)

```bash
cp .env.example .env
```

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

- `server.js`: HTTP server and API routes
- `lib/game.js`: levels, scoring, slot rotation, retiring
- `lib/mbta.js`: MBTA V3 stations + predictions
- `lib/verify.js`: Gemini photo match, with honor-system fallback
- `lib/store.js`: JSON-file database (`data/db.json`) + photos (`data/photos/`)
- `public/`: phone web app (no build step)
- `test/api.test.js`: end-to-end API tests with a fake MBTA, fake verifier and fake clock

## Reset demo data

Stop the server, delete `data/db.json` and `data/photos/`, then start again.
