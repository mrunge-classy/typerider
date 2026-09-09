'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3034);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const DELETED_FILE = path.join(DATA_DIR, 'deleted.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 3;
const MAX_LIMIT = 50;

// Abuse ceilings. Everything the API can create is held in memory and mirrored
// to disk, so every collection that a request can grow needs a bound that does
// not depend on the caller behaving. A board only ever shows MAX_LIMIT rows, so
// keeping 500 is already far more history than the game needs.
const MAX_ENTRIES = 500;                    // rows on the live board
const MAX_DELETED = 200;                    // admin-removed riders retained
const MAX_ARCHIVES = 50;                    // past boards kept on disk
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;  // an archive larger than this is not read
const MAX_TRACKED_IPS = 5000;               // rate-limiter table size

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------------------------------------------------------------- score store

// Kept entirely in memory and mirrored to JSON files; the whole board is a few
// hundred rows at most, so there is no reason to reach for a database here.
//
// The live board is `scores.json`. Wiping it is not a delete: the old board is
// copied whole into `archive/` and a new one takes its place, and a single
// removed rider lands in `deleted.json` carrying the id and start date of the
// board it was removed from.
let board = newBoard();
let deleted = [];
let settings = { leaderboardLimit: DEFAULT_LIMIT };
let writeQueue = Promise.resolve();
let pendingWrites = new Map();

function newBoard() {
  return { id: crypto.randomUUID(), createdAt: Date.now(), entries: [] };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[typerider] could not read ${path.basename(file)}:`, err.message);
    }
    return null;
  }
}

// Every write goes through the one queue, so a burst of scores and an admin
// action can never interleave into a half-written file.
//
// Writes to the same file coalesce: only the newest value is kept, and it is
// serialized when its turn comes rather than when it was queued. A flood of
// accepted scores therefore costs one pending snapshot, not one per request --
// queueing a full copy of the board per POST was itself a way to run the
// process out of memory.
function writeJson(file, value) {
  const first = !pendingWrites.has(file);
  pendingWrites.set(file, value);
  if (!first) return writeQueue;

  writeQueue = writeQueue.then(async () => {
    if (!pendingWrites.has(file)) return;
    const queued = pendingWrites.get(file);
    // Claim it before any await: whatever arrives from here on is a new write
    // that queues its own flush.
    pendingWrites.delete(file);
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(queued, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }).catch((err) => {
    console.error(`[typerider] could not write ${path.basename(file)}:`, err.message);
  });
  return writeQueue;
}

const persistScores = () => writeJson(SCORES_FILE, board);
const persistDeleted = () => writeJson(DELETED_FILE, deleted);
const persistSettings = () => writeJson(SETTINGS_FILE, settings);

// A board that predates the archive feature is a bare array of runs. Date it
// from its oldest run so the homepage does not claim the board started today.
function inferStart(entries) {
  const stamps = entries.map((e) => Number(e.playedAt)).filter(Number.isFinite);
  if (stamps.length) return Math.min(...stamps);
  try {
    return Math.round(fs.statSync(SCORES_FILE).mtimeMs);
  } catch {
    return Date.now();
  }
}

function loadScores() {
  const parsed = readJson(SCORES_FILE);
  if (!parsed) return;

  let legacy = false;
  if (Array.isArray(parsed)) {
    legacy = true;
    board = { id: crypto.randomUUID(), createdAt: inferStart(parsed), entries: parsed };
  } else if (Array.isArray(parsed.entries)) {
    board = {
      id: parsed.id || crypto.randomUUID(),
      createdAt: Number(parsed.createdAt) || inferStart(parsed.entries),
      entries: parsed.entries
    };
  } else {
    return;
  }

  let backfilled = false;
  for (const entry of board.entries) {
    if (!entry.id) {
      entry.id = crypto.randomUUID();
      backfilled = true;
    }
  }

  // A file written before the cap existed (or edited by hand) is trimmed to the
  // fastest MAX_ENTRIES riders rather than loaded whole.
  let trimmed = false;
  if (board.entries.length > MAX_ENTRIES) {
    const dropped = board.entries.length - MAX_ENTRIES;
    board.entries = board.entries
      .slice()
      .sort((a, b) => b.wpm - a.wpm || b.accuracy - a.accuracy || a.playedAt - b.playedAt)
      .slice(0, MAX_ENTRIES);
    trimmed = true;
    console.warn(`[typerider] scores.json held more than ${MAX_ENTRIES} rows; dropped ${dropped}`);
  }

  if (legacy || backfilled || trimmed) persistScores();
}

function loadDeleted() {
  const parsed = readJson(DELETED_FILE);
  if (!Array.isArray(parsed)) return;
  deleted = parsed.slice(-MAX_DELETED);
  if (deleted.length < parsed.length) persistDeleted();
}

function loadSettings() {
  const parsed = readJson(SETTINGS_FILE);
  const limit = parsed && cleanLimit(parsed.leaderboardLimit);
  if (limit) settings.leaderboardLimit = limit;
}

function cleanLimit(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_LIMIT && n <= MAX_LIMIT ? n : null;
}

// Rank within a class, not within the whole board: a mobile rider placed 30th
// overall has to be reachable, so the filter has to happen before the slice.
// Runs recorded before there was a class ('unknown') are left out of the
// filtered views rather than being guessed into one -- see loadScores.
function leaderboard(limit = settings.leaderboardLimit, device = null) {
  return board.entries
    .filter((entry) => !device || entry.device === device)
    .sort((a, b) => b.wpm - a.wpm || b.accuracy - a.accuracy || a.playedAt - b.playedAt)
    .slice(0, limit)
    .map((entry, i) => ({ rank: i + 1, ...entry }));
}

// How many riders sit on each board, including the ones predating the split.
// The homepage uses it to label the filters and to explain the leftovers.
function deviceCounts() {
  const counts = { mobile: 0, desktop: 0, unknown: 0 };
  for (const entry of board.entries) {
    const device = DEVICES.includes(entry.device) ? entry.device : 'unknown';
    counts[device]++;
  }
  return counts;
}

// ------------------------------------------------------------- administration

function archiveName(b) {
  const stamp = new Date(b.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `board-${stamp}-${b.id}.json`;
}

function deleteEntry(id) {
  const i = board.entries.findIndex((e) => e.id === id);
  if (i === -1) return null;

  const [entry] = board.entries.splice(i, 1);
  deleted.push({
    entry,
    boardId: board.id,
    boardCreatedAt: board.createdAt,
    deletedAt: Date.now()
  });
  // The removal log is a log, not an archive: past MAX_DELETED the oldest go.
  if (deleted.length > MAX_DELETED) deleted.splice(0, deleted.length - MAX_DELETED);
  persistScores();
  persistDeleted();
  return entry;
}

// Resetting an empty board writes nothing: without that, a loop of resets is a
// way to fill the disk (and, through listArchives, the heap) with empty boards.
async function resetBoard() {
  const previous = board;
  board = newBoard();
  persistScores();

  if (!previous.entries.length) {
    await writeQueue;
    return { archived: null, archivedEntries: 0 };
  }

  const file = archiveName(previous);
  writeJson(path.join(ARCHIVE_DIR, file), previous);
  await writeQueue;
  const pruned = await pruneArchives();
  return { archived: file, archivedEntries: previous.entries.length, pruned };
}

async function archiveFiles() {
  let files = [];
  try {
    files = await fsp.readdir(ARCHIVE_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // The name carries the board's start time, so a plain descending sort is
  // newest-first without opening a single file.
  return files.filter((f) => /^board-.+\.json$/.test(f)).sort().reverse();
}

// Keep the newest MAX_ARCHIVES boards; older ones are deleted from disk.
async function pruneArchives() {
  const stale = (await archiveFiles()).slice(MAX_ARCHIVES);
  for (const file of stale) {
    try {
      await fsp.unlink(path.join(ARCHIVE_DIR, file));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[typerider] could not prune ${file}:`, err.message);
    }
  }
  return stale.length;
}

// Reads at most MAX_ARCHIVES files, and skips any single file that is too big
// to be a board this server wrote, so listing archives has a fixed cost even if
// something dropped a huge JSON file into the directory.
async function listArchives() {
  const files = (await archiveFiles()).slice(0, MAX_ARCHIVES);
  const out = [];
  for (const file of files) {
    const full = path.join(ARCHIVE_DIR, file);
    try {
      if ((await fsp.stat(full)).size > MAX_ARCHIVE_BYTES) {
        console.warn(`[typerider] skipping oversized archive ${file}`);
        continue;
      }
    } catch {
      continue;
    }
    const data = readJson(full);
    if (!data || !Array.isArray(data.entries)) continue;
    out.push({ id: data.id, createdAt: data.createdAt, entries: data.entries.length, file });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function readArchive(id) {
  const archives = await listArchives();
  const hit = archives.find((a) => a.id === id);
  return hit ? readJson(path.join(ARCHIVE_DIR, hit.file)) : null;
}

// ------------------------------------------------------------------ validation

const NAME_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

// ----------------------------------------------------------- input method

// What separates the two boards is not the device, it is how the text was
// entered: a glass keyboard is slower than a physical one. So a phone paired
// with a Bluetooth keyboard belongs on the desktop board, and classifying on
// input method rather than device identity is what makes that fall out
// naturally instead of needing an exception. Do not "fix" this back to UA
// sniffing -- the values are named mobile/desktop only to match the wording
// of the issue this came from.
//
// Every signal below is forgeable. The client-side ones are self-reported and
// a determined cheat edits the payload; the headers are spoofable in devtools
// in seconds. Together they mean a cheat has to fake all of them consistently,
// which raises the cost -- it does not prevent it, and nothing here should be
// presented to a player as if it did.
const DEVICES = ['mobile', 'desktop'];
const UA_MOBILE = /Mobi|Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry/i;

const countOf = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

function serverSaysMobile(req) {
  const headers = (req && req.headers) || {};
  // Sec-CH-UA-Mobile is the browser answering the question directly, but only
  // Chromium sends it; the UA string is the fallback for everyone else.
  const hint = headers['sec-ch-ua-mobile'];
  if (hint === '?1') return true;
  if (hint === '?0') return false;
  return UA_MOBILE.test(String(headers['user-agent'] || ''));
}

/* Returns the class the run is filed under plus, when the signals disagree, the
   reason -- kept on the entry so an admin can see why a run landed where it did
   rather than having to trust the classifier blindly. */
function classifyInput(raw, req) {
  const evidence = raw && typeof raw === 'object' ? raw : {};
  const keyed = countOf(evidence.keyStrokes);     // keydowns carrying a physical .code
  const touched = countOf(evidence.touchStrokes); // characters entered while touching
  const coarse = evidence.coarsePointer === true;
  const headerMobile = serverSaysMobile(req);

  // A physical keyboard was demonstrably used, so the run gets no benefit from
  // the slower board -- whatever the device says it is. This is both the
  // anti-cheat rule and simply the correct answer.
  if (keyed > 0) {
    return { device: 'desktop', flag: headerMobile ? 'keyboard-on-mobile-device' : null };
  }

  if (touched > 0 && coarse) {
    // Client evidence says touch while both server-side signals say otherwise:
    // either a forged payload or a touchscreen PC. Desktop is the right answer
    // for both, so the tie breaks against the claim rather than for it.
    if (!headerMobile) return { device: 'desktop', flag: 'touch-claim-without-header' };
    return { device: 'mobile', flag: null };
  }

  // Nothing observed from the run at all. The real client always reports, so
  // this is a hand-built request or a stale cached page -- and headers alone are
  // the one signal a forger gets for free, so filing it as mobile on their say-so
  // would leave the cheapest possible cheat wide open. It goes on neither board:
  // visible under "all runs", ranked against nobody.
  return { device: 'unknown', flag: 'no-input-evidence' };
}

function validateRun(body, req) {
  const name = cleanName(body.name);
  if (!name) return { error: 'Username must be 2-16 letters, digits, spaces, . _ or -' };

  const wpm = Number(body.wpm);
  const accuracy = Number(body.accuracy);
  const durationMs = Number(body.durationMs);
  const chars = Number(body.chars);
  const track = typeof body.track === 'string' ? body.track.slice(0, 40) : '';

  const finite = [wpm, accuracy, durationMs, chars].every(Number.isFinite);
  if (!finite) return { error: 'Malformed run' };
  if (wpm <= 0 || wpm > 250) return { error: 'Implausible speed' };
  if (accuracy < 0 || accuracy > 100) return { error: 'Implausible accuracy' };
  if (durationMs < 2000 || durationMs > 30 * 60 * 1000) return { error: 'Implausible duration' };
  if (chars < 40 || chars > 5000) return { error: 'Implausible run length' };

  // Re-derive the speed from the raw counts so a tampered `wpm` cannot outrank
  // an honest one: 5 characters = 1 word, the standard WPM convention.
  const derived = (chars / 5) / (durationMs / 60000);
  if (Math.abs(derived - wpm) > 2) return { error: 'Run does not add up' };

  const { device, flag } = classifyInput(body.input, req);

  return {
    run: {
      id: crypto.randomUUID(),
      name,
      wpm: Math.round(wpm * 10) / 10,
      accuracy: Math.round(accuracy * 10) / 10,
      track,
      device,
      deviceFlag: flag,
      playedAt: Date.now()
    }
  };
}

// The slowest rider on the board -- the one a full board gives up first.
function slowestIndex() {
  let worst = 0;
  for (let i = 1; i < board.entries.length; i++) {
    const a = board.entries[i];
    const b = board.entries[worst];
    if (a.wpm < b.wpm || (a.wpm === b.wpm && a.accuracy < b.accuracy)) worst = i;
  }
  return worst;
}

// One row per name *per class*, and never more than MAX_ENTRIES rows. Keying on
// the name alone would let a rider's fast desktop run stand as their only entry
// and quietly suppress their own slower mobile one, which would leave the mobile
// board permanently empty for anyone who also plays at a desk -- the two boards
// have to be able to hold the same rider twice.
//
// A new name on a full board still has to beat the slowest rider to get a seat,
// which is what stops an attacker minting unlimited usernames to grow the board
// without end; classes share that one budget deliberately.
function recordRun(run) {
  const existing = board.entries.find((s) =>
    s.name.toLowerCase() === run.name.toLowerCase() && s.device === run.device);

  if (existing) {
    if (run.wpm <= existing.wpm) return { improved: false, full: false };
    // Keep the row's id so anything already referencing it still resolves.
    Object.assign(existing, run, { id: existing.id });
    persistScores();
    return { improved: true, full: false };
  }

  if (board.entries.length >= MAX_ENTRIES) {
    const i = slowestIndex();
    if (run.wpm <= board.entries[i].wpm) return { improved: false, full: true };
    board.entries[i] = run;
  } else {
    board.entries.push(run);
  }
  persistScores();
  return { improved: true, full: false };
}

// --------------------------------------------------------------- rate limiting

// Every /api/ route is metered, not just score submission: reading the board is
// cheap but not free, and the admin routes touch the disk.
const BUDGETS = {
  read: { limit: 120, windowMs: 60000 },
  write: { limit: 30, windowMs: 60000 },
  admin: { limit: 60, windowMs: 60000 },
  reset: { limit: 6, windowMs: 60000 },  // each accepted reset can write a file
  // Failed admin logins only. The admin budget above is 60/min, which is a
  // generous guessing allowance rather than a defence; this caps how many
  // passwords one caller can actually try.
  authfail: { limit: 5, windowMs: 60000 }
};

// One fixed window counter per caller and budget -- two numbers, so a caller
// hammering the API cannot make its own bucket grow (the old limiter appended a
// timestamp per request, including the ones it had already rejected).
const hits = new Map();

function rateLimited(ip, kind) {
  const budget = BUDGETS[kind];
  const key = `${kind}\u0000${ip}`;
  const now = Date.now();

  let bucket = hits.get(key);
  if (!bucket || now - bucket.start >= budget.windowMs) bucket = { start: now, count: 0 };
  bucket.count++;

  // Re-insert so Map iteration order stays least-recently-seen first.
  hits.delete(key);
  hits.set(key, bucket);
  if (hits.size > MAX_TRACKED_IPS) evictStaleCallers(now);

  return bucket.count > budget.limit;
}

// rateLimited() counts the request it is asked about. Refusing a password
// attempt has to be decided BEFORE the comparison happens, so this reads a
// bucket without touching it.
function overBudget(ip, kind) {
  const bucket = hits.get(`${kind}\u0000${ip}`);
  if (!bucket || Date.now() - bucket.start >= BUDGETS[kind].windowMs) return false;
  return bucket.count >= BUDGETS[kind].limit;
}

// Drop expired buckets first; if the table is still full, drop the least
// recently seen tenth. Never clear the whole table -- that used to hand every
// attacker in a flood a fresh budget.
const LONGEST_WINDOW = Math.max(...Object.values(BUDGETS).map((b) => b.windowMs));

function evictStaleCallers(now) {
  for (const [key, bucket] of hits) {
    if (now - bucket.start >= LONGEST_WINDOW) hits.delete(key);
  }
  if (hits.size <= MAX_TRACKED_IPS) return;
  let drop = Math.ceil(MAX_TRACKED_IPS / 10);
  for (const key of hits.keys()) {
    hits.delete(key);
    if (--drop <= 0) break;
  }
}

// nginx sets X-Real-IP; a client cannot be allowed to. Trust the header only
// when the connection itself came from the loopback/private side, which is
// where the reverse proxy sits, and never key the table on an unbounded string.
const LOCAL_PEER = /^(::1|::ffff:127\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i;

function clientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const header = req.headers['x-real-ip'];
  if (typeof header === 'string' && header && LOCAL_PEER.test(peer)) {
    return header.split(',')[0].trim().slice(0, 45) || peer;
  }
  return peer;
}

// Both halves of the admin surface: the JSON API and the page that drives it.
const isAdminPage = (pathname) => pathname === '/admin' || pathname.startsWith('/admin/');
const isAdminRoute = (pathname) => pathname.startsWith('/api/admin') || isAdminPage(pathname);

function budgetFor(pathname, method) {
  if (pathname === '/api/admin/reset') return 'reset';
  if (pathname.startsWith('/api/admin')) return 'admin';
  // The admin page is static but it is not public; without this it would
  // draw the public read budget of 120/min.
  if (isAdminPage(pathname)) return 'admin';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

// ------------------------------------------------------------ admin identity

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

// Digest both sides rather than comparing them directly. timingSafeEqual throws
// on a length mismatch, and the length check that would avoid the throw leaks
// how long the password is; two 32-byte digests always compare in constant time.
function passwordMatches(given) {
  return crypto.timingSafeEqual(sha256(given), sha256(ADMIN_PASSWORD));
}

// Only the password is checked, not the username. nginx's htpasswd checks both,
// but a mismatch there would surface as a 401 with no way to tell which half was
// wrong -- and the app has exactly one account, so the username carries nothing.
function passwordFrom(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const space = header.indexOf(' ');
  if (space === -1 || header.slice(0, space).toLowerCase() !== 'basic') return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(space + 1), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

// With ADMIN_PASSWORD set the app defends itself and a reverse proxy in front is
// defence in depth. With it unset the old arrangement still holds -- nginx does
// the authenticating and proxies from this machine -- so a request that did NOT
// arrive through something local is refused rather than trusted. That keeps the
// deployed setup working untouched while closing the case this was really about:
// `node server.js` on a public interface with no proxy at all.
function adminAllowed(req, res, ip, pathname) {
  const page = isAdminPage(pathname);

  if (!ADMIN_PASSWORD) {
    if (LOCAL_PEER.test(req.socket.remoteAddress || '')) return true;
    sendRefusal(res, 403, page, 'The admin surface is not reachable from here.');
    return false;
  }

  const challenge = { 'WWW-Authenticate': 'Basic realm="Typerider admin", charset="UTF-8"' };

  // Arriving with no credential is not a guess: it reveals nothing and must not
  // spend the budget, or a caller's own tooling could lock them out --
  // `typerider-leaderboard check` knocks anonymously on purpose, to prove the
  // door is shut. Anonymous callers are still metered by the admin budget above.
  const given = passwordFrom(req);
  if (given === null) {
    sendRefusal(res, 401, page, 'Authentication required.', challenge);
    return false;
  }

  // Decided before the comparison, so a caller gets a fixed number of guesses a
  // minute whatever the answers are -- the right password is refused too once
  // the budget is gone. Buckets key per IP, so a flood locks out only the
  // flooder; do NOT "fix" this by moving auth above the rate limiter, which
  // would hand an attacker unmetered guessing.
  if (overBudget(ip, 'authfail')) {
    sendRefusal(res, 429, page, 'Too many failed logins, wait a minute.',
      { 'Retry-After': '60' });
    return false;
  }

  if (passwordMatches(given)) return true;

  rateLimited(ip, 'authfail');
  sendRefusal(res, 401, page, 'Authentication required.', challenge);
  return false;
}

// -------------------------------------------------------------------- plumbing

// A browser asking for the admin page should not be handed raw JSON when it is
// turned away, and the CLI should not have to parse prose. One refusal, rendered
// as whatever the caller came for.
function sendRefusal(res, status, page, message, headers = {}) {
  if (!page) return sendJson(res, status, { error: message }, headers);
  const body = message + '\n';
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  if (rel === '/play') rel = '/play.html';
  if (rel === '/admin') rel = '/admin/index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>404</title>' +
        '<body style="font:16px system-ui;padding:3rem"><h1>404</h1>' +
        '<p>Nothing here. <a href="/">Back to Typerider</a></p>');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'ETag': etag,
      // HTML and the service worker must never be served stale, or an update
      // would take a hard refresh to show up.
      'Cache-Control': isHtml || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Meter the API and the admin page, and nothing else. Widening this to every
  // path would meter the static shell too: one homepage load is eight requests,
  // so the 120/min read budget would 429 a real visitor after fifteen of them.
  const metered = url.pathname.startsWith('/api/') || isAdminPage(url.pathname);
  if (metered && rateLimited(ip, budgetFor(url.pathname, req.method))) {
    sendRefusal(res, 429, isAdminPage(url.pathname), 'Too many requests, slow down.',
      { 'Retry-After': '60' });
    return;
  }

  // Auth sits after the limiter on purpose: password attempts are metered.
  if (isAdminRoute(url.pathname) && !adminAllowed(req, res, ip, url.pathname)) return;

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const asked = Number(url.searchParams.get('limit'));
    const limit = Math.min(asked > 0 ? asked : settings.leaderboardLimit, MAX_LIMIT);
    // An unrecognised device is treated as "no filter" rather than as an error:
    // the board is a public read, and a typo in a query string should not 400.
    const wanted = url.searchParams.get('device');
    const device = DEVICES.includes(wanted) ? wanted : null;
    sendJson(res, 200, {
      entries: leaderboard(limit, device),
      players: board.entries.length,
      counts: deviceCounts(),
      device,
      board: { id: board.id, createdAt: board.createdAt },
      limit
    });
    return;
  }

  if (url.pathname === '/api/score' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const { error, run } = validateRun(body || {}, req);
    if (error) {
      sendJson(res, 400, { error });
      return;
    }
    const { improved, full } = recordRun(run);
    // Ranked on the board the run was actually filed under, which is the only
    // comparison that means anything now that the two are scored separately.
    const list = leaderboard(settings.leaderboardLimit, run.device);
    const rank = list.findIndex((e) =>
      e.name.toLowerCase() === run.name.toLowerCase() && e.device === run.device);
    sendJson(res, 200, {
      improved,
      full,
      rank: rank === -1 ? null : rank + 1,
      device: run.device,
      entries: list,
      players: board.entries.length,
      board: { id: board.id, createdAt: board.createdAt }
    });
    return;
  }

  // --- admin ---------------------------------------------------------------
  // Reached only through adminAllowed() above, so the handlers below can assume
  // the caller is entitled to be here. In production nginx also puts basic auth
  // in front of the admin vhost and 404s /api/admin on the public one; that is
  // now defence in depth rather than the only lock — see DEPLOYMENT.md.

  if (url.pathname === '/api/admin/board' && req.method === 'GET') {
    sendJson(res, 200, {
      board: { id: board.id, createdAt: board.createdAt },
      entries: leaderboard(board.entries.length),
      players: board.entries.length,
      settings,
      deleted,
      archives: await listArchives()
    });
    return;
  }

  if (url.pathname === '/api/admin/archive' && req.method === 'GET') {
    const archived = await readArchive(url.searchParams.get('id') || '');
    if (!archived) {
      sendJson(res, 404, { error: 'No archived board with that id' });
      return;
    }
    sendJson(res, 200, { board: archived });
    return;
  }

  if (url.pathname === '/api/admin/entry' && req.method === 'DELETE') {
    const entry = deleteEntry(url.searchParams.get('id') || '');
    if (!entry) {
      sendJson(res, 404, { error: 'No entry with that id on the live board' });
      return;
    }
    await writeQueue;
    sendJson(res, 200, { deleted: entry, players: board.entries.length });
    return;
  }

  if (url.pathname === '/api/admin/reset' && req.method === 'POST') {
    const result = await resetBoard();
    sendJson(res, 200, {
      ...result,
      board: { id: board.id, createdAt: board.createdAt }
    });
    return;
  }

  if (url.pathname === '/api/admin/settings' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const limit = cleanLimit((body || {}).leaderboardLimit);
    if (!limit) {
      sendJson(res, 400, { error: `leaderboardLimit must be a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}` });
      return;
    }
    settings.leaderboardLimit = limit;
    await persistSettings();
    sendJson(res, 200, { settings });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Unknown endpoint' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  serveStatic(req, res, url.pathname);
});

// A connection that dawdles holds a socket and a buffer; keep the ceilings low
// so a pile of half-open requests cannot sit on the process.
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 200;
server.maxHeadersCount = 60;

loadScores();
loadDeleted();
loadSettings();
server.listen(PORT, HOST, () => {
  console.log(`[typerider] listening on http://${HOST}:${PORT} ` +
    `(${board.entries.length} scores, board ${board.id}, top ${settings.leaderboardLimit})`);
  if (!ADMIN_PASSWORD) {
    console.log('[typerider] ADMIN_PASSWORD is not set: /admin and /api/admin ' +
      'answer only to this machine. Set it, or keep a proxy in front.');
  }
});
