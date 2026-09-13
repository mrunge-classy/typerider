status: done

summary:
  Issue #2 is implemented, committed as 2116506 and pushed to origin/main.
  Mobile and desktop runs are now ranked on separate boards, split by INPUT
  METHOD (physical keys vs a soft keyboard) rather than by device identity, so
  a Bluetooth or case keyboard files as desktop wherever it is plugged in.
  The homepage board gains an All/Mobile/Desktop filter and a "Typed on"
  column; the two duplicated leaderboard tables now share public/board.js.

  New: public/input-method.js (counts input evidence, decides nothing),
  public/board.js (one table renderer, two callers).
  Changed: server.js (classification, per-class ranking, entries keyed by
  name+class), game.js, home.js, index.html, play.html, styles.css.

  EXISTING CLASS-LESS ENTRIES: left unclassified on purpose. They appear under
  "All runs" and on neither the mobile nor the desktop board, labelled
  "Unclassified". They are NOT backfilled to desktop -- some of them are real
  mobile scores and guessing would put a phone run on the keyboard board. Max
  will see this on his own leaderboard: whatever is on it today keeps its rank
  under "All runs" and drops out of the two filtered views until it is
  re-ridden. A board reset clears it; nothing else needs doing.

  HONESTY NOTE, please keep this wording with the feature: every signal used is
  forgeable. Requiring several to agree raises the cost of faking a mobile
  score; it does not prevent it, and the UI does not claim it does.

  Supersedes origin/feature/mobile-desktop-detection (ff8b3cf) -- see (b).

verified:
  - node --check on every changed JS file.
  - Classification matrix by curl against a real server: honest phone -> mobile;
    honest desktop -> desktop; iPad + case keyboard -> desktop; forged touch
    payload from a desktop UA -> desktop; bare request with no evidence and a
    spoofed mobile UA -> unclassified, on neither board.
  - Same rider recorded on both boards at once (30 wpm mobile, 100 wpm desktop),
    which is the case that keying by name alone would have broken.
  - Per-class ranking read back from /api/leaderboard, ?device=mobile and
    ?device=desktop.
  - Headless Chromium drove a full game twice: a simulated physical keyboard
    reported keyStrokes=282 touchStrokes=0, a simulated soft keyboard reported
    keyStrokes=0 touchStrokes=275, counters reset between runs.
  - Homepage filter clicked in-browser: refetches, swaps rows, drops the
    now-redundant device column, updates the champion label and the note.
  - Story-modal regression re-run after the home.js refactor: all six checks
    pass.
  - Shared renderer checked for both column sets, name escaping and "you"
    highlighting.
  - Finally: cloned 2116506 fresh from origin into a temp dir, ran it, posted
    two runs and read all three board views back. That clone is what Max is
    about to deploy.

next:
  (a) Nothing required. main is deployable as it stands.
  (b) Close origin/feature/mobile-desktop-detection unmerged. It classifies on
      device identity, returns on a User-Agent regex before consulting any other
      signal, files every iPad as mobile, "validates" for tampering inside the
      environment being validated, and fingerprints the browser (UA, platform,
      language, screen, timezone, hardware) -- which contradicts the homepage's
      own "no account, no e-mail, no cookie banner" promise. I did not touch the
      branch; deleting it is Max's call.
  (c) public/sw.js still precaches only the old shell, so board.js and
      input-method.js are not in its install list. The worker is network-first
      and caches them on first load, so this bites only a brand-new install that
      goes offline immediately. I was asked not to touch sw.js; adding the two
      paths to SHELL is a one-line follow-up whenever it is free.
  (d) An old cached client that posts without input evidence files as
      "Unclassified" rather than being trusted on its User-Agent. Network-first
      keeps that window short, and it is the deliberate trade: no evidence buys
      no board.
