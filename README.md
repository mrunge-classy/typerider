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
| `POST /api/score` | `{name, wpm, accuracy, track, durationMs, chars}` → `{improved, full, rank, entries, players, board}` |

Submissions are checked rather than trusted. The server re-derives WPM from the raw
`chars` and `durationMs` and rejects the run if the claimed number is off by more than 2,
so editing the payload on its way out doesn't buy a rank. Runs outside plausible bounds
(speed, accuracy, duration, length) are refused, usernames are constrained to 2–16
characters, and writes are rate-limited to 30 per minute per IP. There is one row per
username, case-insensitive, and only a faster run replaces it.

The board itself is capped at **500 rows**. Once it is full a new name has to beat the
slowest rider on it to take a seat, and a run that doesn't comes back `full: true`. That
cap is what keeps the store finite: without it, anyone able to reach `POST /api/score`
could mint unlimited usernames and grow an in-memory board until the process died. The
other collections a request can grow are bounded the same way — see
[DEPLOYMENT.md](DEPLOYMENT.md#abuse-ceilings).

There is a second, admin-only surface under `/api/admin/*` for changing the board size,
removing a rider, and resetting the board. **It carries no authentication of its own** — in
production it lives behind HTTP basic auth on a separate hostname, and the public vhost
404s the whole `/api/admin` prefix. Anyone running this themselves has to put equivalent
protection in front of it, or leave those routes unreachable.

Removing a rider is not a hard delete: the row moves to `data/deleted.json` carrying the
id and start date of the board it came from. Resetting copies the whole board into
`data/archive/` and starts a new one, so past boards stay readable — resetting a board
that is already empty archives nothing, and the 50 newest archives are kept.

## Offline and mobile

There is a service worker (`public/sw.js`) and a web manifest, so the game installs to a
home screen and plays offline — the story text ships with the app, and only score
submission needs the network. The worker is network-first, so an installed copy picks up
updates on the next load instead of pinning an old build.

## Layout

```
server.js                 HTTP server, score store, validation, admin routes
bin/typerider-leaderboard command line for the leaderboard API
public/
  index.html  home.js     homepage and its live leaderboard
  play.html   game.js     the game itself
  tracks.js               the three story variations
  styles.css              all styling
  sw.js  manifest.webmanifest
  admin/index.html        leaderboard admin, self-contained
  icons/
```

## Administering the leaderboard

`bin/typerider-leaderboard` drives the admin API from the shell, so removing a rider does
not mean copying a UUID out of a web page into `curl`.

```
typerider-leaderboard board          # the live board, every entry with its id
typerider-leaderboard top            # what visitors see on the homepage
typerider-leaderboard rm <id|name>   # remove one rider (kept in the deleted log)
typerider-leaderboard reset          # retire the board, start a fresh one
typerider-leaderboard limit 10       # rows shown on the homepage (3-50)
typerider-leaderboard deleted        # riders removed from a board
typerider-leaderboard archives       # boards that have been retired
typerider-leaderboard check          # reachability and access control, read-only
```

`rm` and `reset` ask for confirmation — `reset` wants the board id typed back, since it
retires a live public board. `--json` on any command prints the raw response, and
`--admin-url http://127.0.0.1:3999` points it at a local dev server.

Nothing here is destructive by accident and no board is ever lost: a removed rider goes to
a deleted log that records which board it came from, and a reset copies the whole board
into an archive before starting the next one.

The admin API sits behind HTTP basic auth on its own host. The tool reads the password
from `--password-file`, `$TYPERIDER_ADMIN_PASSWORD`, or
`~/.config/typerider-leaderboard/admin.pw.gpg` — with the `.gpg` file, gpg prompts for the
passphrase itself, so it never passes through the tool. No credential lives in this repo.

## Deployment

In production it runs as a single Node process behind an nginx reverse proxy with a
Let's Encrypt certificate, kept alive by pm2. nginx passes `X-Real-IP` through, which the
rate limiter keys off — the header is honoured only when the connection itself came from
the loopback/private side, so a client cannot spoof its way into a fresh budget; HTML and `sw.js` are served `no-cache` so updates aren't sticky.
There is no build or install step, so deploying is copying the files across and
restarting the process.

## License

MIT — see [LICENSE](LICENSE).
