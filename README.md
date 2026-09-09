# Typerider

A small typing speed test, live at **[typerider.zugriff.at](https://typerider.zugriff.at)**.

Seven short lines, three stories, one words-per-minute score. You type a sentence,
hit <kbd>Enter</kbd>, the next one appears. At the end you get WPM and accuracy, and a
place on the leaderboard if you earned it.

Two of the three stories are in German, one in English.

## Why it looks like this

The whole thing is **plain Node with no dependencies** — `node:http`, `node:fs`, nothing
else. No framework, no build step, no `npm install`. The front end is three script files
and one stylesheet, served as-is. `git clone && node server.js` is the entire setup.

That is a deliberate constraint rather than a shortcut: the app serves a handful of static
files and keeps a few hundred rows of scores, and at that size a database and a bundler
cost more than they return.

## Running it

```bash
node server.js            # http://127.0.0.1:3034
PORT=3999 node server.js  # or pick your own port
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3034` | |
| `HOST` | `127.0.0.1` | bind address |
| `DATA_DIR` | `./data` | where the JSON state lives |

Scores land in `data/scores.json`. Delete the file to start a fresh board.

## The game

`public/tracks.js` holds the three variations — id, title, language, and up to seven
lines each. Adding a fourth is a matter of appending an object to that array; nothing
else needs to know about it.

Timing starts on the first keystroke of a run, not when the page loads, so reading the
first line doesn't cost you. WPM uses the standard convention of five characters to a
word.

## Leaderboard API

| | |
|---|---|
| `GET /api/leaderboard?limit=10` | `{ entries: [{rank, name, wpm, accuracy, track, playedAt}], players, board, limit }` |
| `POST /api/score` | `{name, wpm, accuracy, track, durationMs, chars}` → `{improved, rank, entries, players, board}` |

Submissions are checked rather than trusted. The server re-derives WPM from the raw
`chars` and `durationMs` and rejects the run if the claimed number is off by more than 2,
so editing the payload on its way out doesn't buy a rank. Runs outside plausible bounds
(speed, accuracy, duration, length) are refused, usernames are constrained to 2–16
characters, and writes are rate-limited to 30 per minute per IP. There is one row per
username, case-insensitive, and only a faster run replaces it.

There is a second, admin-only surface under `/api/admin/*` for changing the board size,
removing a rider, and resetting the board. **It carries no authentication of its own** — in
production it lives behind HTTP basic auth on a separate hostname, and the public vhost
404s the whole `/api/admin` prefix. Anyone running this themselves has to put equivalent
protection in front of it, or leave those routes unreachable.

Removing a rider is not a hard delete: the row moves to `data/deleted.json` carrying the
id and start date of the board it came from. Resetting copies the whole board into
`data/archive/` and starts a new one, so past boards stay readable.

## Offline and mobile

There is a service worker (`public/sw.js`) and a web manifest, so the game installs to a
home screen and plays offline — the story text ships with the app, and only score
submission needs the network. The worker is network-first, so an installed copy picks up
updates on the next load instead of pinning an old build.

## Layout

```
server.js                 HTTP server, score store, validation, admin routes
public/
  index.html  home.js     homepage and its live leaderboard
  play.html   game.js     the game itself
  tracks.js               the three story variations
  styles.css              all styling
  sw.js  manifest.webmanifest
  admin/index.html        leaderboard admin, self-contained
  icons/
```

## Deployment

In production it runs as a single Node process behind an nginx reverse proxy with a
Let's Encrypt certificate, kept alive by pm2. nginx passes `X-Real-IP` through, which the
rate limiter keys off; HTML and `sw.js` are served `no-cache` so updates aren't sticky.
There is no build or install step, so deploying is copying the files across and
restarting the process.

## License

MIT — see [LICENSE](LICENSE).
