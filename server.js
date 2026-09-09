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
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const DELETED_FILE = path.join(DATA_DIR, 'deleted.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 3;
const MAX_LIMIT = 50;

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
function writeJson(file, value) {
  const snapshot = JSON.stringify(value, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, snapshot, 'utf8');
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
  if (legacy || backfilled) persistScores();
}

function loadDeleted() {
  const parsed = readJson(DELETED_FILE);
  if (Array.isArray(parsed)) deleted = parsed;
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

function leaderboard(limit = settings.leaderboardLimit) {
  return board.entries
    .slice()
    .sort((a, b) => b.wpm - a.wpm || b.accuracy - a.accuracy || a.playedAt - b.playedAt)
    .slice(0, limit)
    .map((entry, i) => ({ rank: i + 1, ...entry }));
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
  persistScores();
  persistDeleted();
  return entry;
}

function resetBoard() {
  const previous = board;
  const file = archiveName(previous);
  writeJson(path.join(ARCHIVE_DIR, file), previous);
  board = newBoard();
  persistScores();
  return { archived: file, archivedEntries: previous.entries.length };
}

async function listArchives() {
  let files = [];
  try {
    files = await fsp.readdir(ARCHIVE_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const data = readJson(path.join(ARCHIVE_DIR, file));
      if (!data || !Array.isArray(data.entries)) return null;
      return { id: data.id, createdAt: data.createdAt, entries: data.entries.length, file };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
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

function validateRun(body) {
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

  return {
    run: {
      id: crypto.randomUUID(),
      name,
      wpm: Math.round(wpm * 10) / 10,
      accuracy: Math.round(accuracy * 10) / 10,
      track,
      playedAt: Date.now()
    }
  };
}

function recordRun(run) {
  const existing = board.entries.find((s) => s.name.toLowerCase() === run.name.toLowerCase());
  let improved = true;
  if (!existing) {
    board.entries.push(run);
  } else if (run.wpm > existing.wpm) {
    // Keep the row's id so anything already referencing it still resolves.
    Object.assign(existing, run, { id: existing.id });
  } else {
    improved = false;
  }
  if (improved) persistScores();
  return improved;
}

// --------------------------------------------------------------- rate limiting

const hits = new Map();

function rateLimited(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const bucket = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  bucket.push(now);
  hits.set(ip, bucket);
  if (hits.size > 5000) hits.clear();
  return bucket.length > limit;
}

// -------------------------------------------------------------------- plumbing

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
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
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const asked = Number(url.searchParams.get('limit'));
    const limit = Math.min(asked > 0 ? asked : settings.leaderboardLimit, MAX_LIMIT);
    sendJson(res, 200, {
      entries: leaderboard(limit),
      players: board.entries.length,
      board: { id: board.id, createdAt: board.createdAt },
      limit
    });
    return;
  }

  if (url.pathname === '/api/score' && req.method === 'POST') {
    if (rateLimited(ip)) {
      sendJson(res, 429, { error: 'Too many submissions, slow down.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const { error, run } = validateRun(body || {});
    if (error) {
      sendJson(res, 400, { error });
      return;
    }
    const improved = recordRun(run);
    const list = leaderboard();
    const rank = list.findIndex((e) => e.name.toLowerCase() === run.name.toLowerCase());
    sendJson(res, 200, {
      improved,
      rank: rank === -1 ? null : rank + 1,
      entries: list,
      players: board.entries.length,
      board: { id: board.id, createdAt: board.createdAt }
    });
    return;
  }

  // --- admin ---------------------------------------------------------------
  // Deliberately unauthenticated in here: nginx puts basic auth in front of
  // typerider-leaderboard.zugriff.at and 404s /api/admin on the public vhost.
  // Both halves are load-bearing — see DEPLOYMENT.md.

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
    const result = resetBoard();
    await writeQueue;
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

loadScores();
loadDeleted();
loadSettings();
server.listen(PORT, HOST, () => {
  console.log(`[typerider] listening on http://${HOST}:${PORT} ` +
    `(${board.entries.length} scores, board ${board.id}, top ${settings.leaderboardLimit})`);
});
