/* Typerider · the game itself: name → story → type → result. */
(function () {
  'use strict';

  var TRACKS = window.TYPERIDER_TRACKS || [];

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  // ------------------------------------------------------------- name stage

  var ADJ = ['Swift', 'Turbo', 'Silent', 'Nacht', 'Blitz', 'Calm', 'Rapid', 'Nebel', 'Iron', 'Neon', 'Wilde', 'Zehn'];
  var NOUN = ['Otter', 'Falke', 'Comet', 'Marder', 'Pilot', 'Rider', 'Luchs', 'Finch', 'Kolibri', 'Rakete', 'Wolf', 'Taste'];

  function suggestNames(n) {
    var out = [];
    var guard = 0;
    while (out.length < n && guard++ < 200) {
      var name = ADJ[Math.floor(Math.random() * ADJ.length)] +
                 NOUN[Math.floor(Math.random() * NOUN.length)] +
                 (Math.random() < 0.35 ? String(Math.floor(Math.random() * 90) + 10) : '');
      if (name.length <= 16 && out.indexOf(name) === -1) out.push(name);
    }
    return out;
  }

  function renderSuggestions() {
    var box = $('suggestions');
    box.querySelectorAll('.chip').forEach(function (c) { c.remove(); });
    suggestNames(3).forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = name;
      b.addEventListener('click', function () {
        $('name').value = name;
        $('name-error').textContent = '';
        $('name').focus();
      });
      box.appendChild(b);
    });
  }

  var NAME_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
  var player = store.get('typerider.name') || '';

  // ------------------------------------------------------------ stage router

  var stages = ['stage-name', 'stage-track', 'stage-game', 'stage-result'];

  function show(id) {
    stages.forEach(function (s) { $(s).classList.toggle('is-active', s === id); });
    if (id === 'stage-game') setTimeout(function () { $('typing').focus(); }, 30);
    if (id === 'stage-name') setTimeout(function () { $('name').focus(); }, 30);
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ track stage

  function renderPicker() {
    $('picker').innerHTML = TRACKS.map(function (t, i) {
      return '<button class="pick" type="button" data-track="' + esc(t.id) + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="body"><strong>' + esc(t.title) + '</strong>' +
        '<span>' + esc(t.blurb) + '</span></span>' +
        '<span class="meta">' + esc(t.langLabel) + '<br>' + t.lines.length + ' lines</span>' +
      '</button>';
    }).join('');

    $('picker').querySelectorAll('.pick').forEach(function (btn) {
      btn.addEventListener('click', function () { startRun(btn.dataset.track); });
    });
  }

  // -------------------------------------------------------------- game state

  var run = null;
  var ticker = null;

  function startRun(trackId) {
    var track = TRACKS.find(function (t) { return t.id === trackId; });
    if (!track) return;

    run = {
      track: track,
      index: 0,
      startedAt: 0,
      finishedAt: 0,
      correctChars: 0,
      typedChars: 0,
      // Keystroke history: every character the rider adds or erases, in order,
      // with the moment it happened. The final text of a line cannot show a
      // typo that was backspaced away — this log can.
      keystrokes: [],
      typedSoFar: '',   // last seen value of the input, to diff the next one against
      strokes: 0,       // keystrokes that count towards accuracy
      mistyped: 0,      // wrong characters typed
      deletedCorrect: 0 // characters that were right and got erased anyway
    };

    $('game-title').firstChild.textContent = track.title;
    $('game-sub').textContent = track.langLabel + ' · ' + track.lines.length + ' lines';
    $('progress').innerHTML = track.lines.map(function () { return '<i></i>'; }).join('');
    $('typing').value = '';
    $('typing').disabled = false;
    $('live-wpm').textContent = '0';
    $('live-acc').textContent = '100%';
    $('live-time').textContent = '0:00';

    paintLine();
    show('stage-game');
  }

  function currentLine() { return run.track.lines[run.index]; }

  function paintProgress() {
    var pips = $('progress').children;
    for (var i = 0; i < pips.length; i++) {
      pips[i].className = i < run.index ? 'done' : (i === run.index ? 'current' : '');
    }
  }

  /* Repaint the prompt so every character carries its own state: matched,
     mistyped, or still ahead of the caret. */
  function paintLine() {
    var target = currentLine();
    var typed = $('typing').value;
    var html = '';

    for (var i = 0; i < target.length; i++) {
      var ch = target[i];
      var cls = 'ch';
      if (ch === ' ') cls += ' space';
      if (i < typed.length) cls += typed[i] === ch ? ' ok' : ' bad';
      if (i === typed.length) cls += ' at';
      html += '<span class="' + cls + '">' + (ch === ' ' ? '&nbsp;' : esc(ch)) + '</span>';
    }
    // Anything typed past the end of the line is an overshoot; show it in red.
    if (typed.length > target.length) {
      html += '<span class="ch bad">' + esc(typed.slice(target.length)) + '</span>';
    }

    $('prompt').innerHTML = html;
    $('prompt').lang = run.track.lang;
    paintProgress();
  }

  function lineStats(typed, target) {
    var correct = 0;
    for (var i = 0; i < typed.length; i++) {
      if (i < target.length && typed[i] === target[i]) correct++;
    }
    return { correct: correct, typed: typed.length };
  }

  var KEYLOG_MAX = 20000; // a full round is a few hundred entries; this is only a guard

  function logKey(type, key, pos, mistake) {
    if (run.keystrokes.length >= KEYLOG_MAX) return;
    var now = Date.now();
    run.keystrokes.push({
      t: now,                                       // wall clock
      at: run.startedAt ? now - run.startedAt : 0,  // ms into the run
      line: run.index,
      pos: pos,
      type: type,                                   // 'insert' | 'delete' | 'enter'
      key: key,
      expected: type === 'enter' ? '' : (currentLine()[pos] || ''),
      mistake: !!mistake
    });
  }

  /* Score what changed between the previous value of the input and the new one.
     Works for single keys, held-down repeats, pastes and selection replacements
     alike: diff off the common prefix and suffix, then judge each character. */
  function trackInput(next) {
    var prev = run.typedSoFar;
    if (next === prev) return;
    var target = currentLine();

    var start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    var pEnd = prev.length, nEnd = next.length;
    while (pEnd > start && nEnd > start && prev[pEnd - 1] === next[nEnd - 1]) { pEnd--; nEnd--; }

    // Erased characters are judged against the slots they used to occupy.
    for (var i = start; i < pEnd; i++) {
      var wasRight = prev[i] === target[i];
      logKey('delete', prev[i], i, wasRight);
      // Rubbing out a wrong character is a free correction; rubbing out a right
      // one is the rider undoing their own good work, and that costs.
      if (wasRight) { run.deletedCorrect++; run.strokes++; }
    }
    // Added characters are judged against the slots they now occupy.
    for (var j = start; j < nEnd; j++) {
      var hit = next[j] === target[j];
      logKey('insert', next[j], j, !hit);
      run.strokes++;
      if (!hit) run.mistyped++;
    }

    run.typedSoFar = next;
  }

  function mistakeCount() { return run.mistyped + run.deletedCorrect; }

  /* Accuracy over the whole keystroke history, not over the text left standing:
     a typo that was corrected still happened, and so did the correction. */
  function accuracyPct() {
    if (!run.strokes) return 100;
    return Math.max(0, (run.strokes - mistakeCount()) / run.strokes) * 100;
  }

  function liveTotals() {
    var partial = lineStats($('typing').value, currentLine());
    var correct = run.correctChars + partial.correct;
    var typed = run.typedChars + partial.typed;
    var elapsed = run.startedAt ? Date.now() - run.startedAt : 0;
    var minutes = elapsed / 60000;
    return {
      correct: correct,
      typed: typed,
      elapsed: elapsed,
      wpm: minutes > 0 ? (correct / 5) / minutes : 0,
      accuracy: accuracyPct()
    };
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function tick() {
    if (!run || !run.startedAt) return;
    var t = liveTotals();
    // Under a second the rate is meaningless (and enormous) — hold at 0.
    $('live-wpm').textContent = t.elapsed < 1000 ? '0' : Math.min(999, Math.round(t.wpm));
    $('live-acc').textContent = Math.round(t.accuracy) + '%';
    $('live-time').textContent = fmtTime(t.elapsed);
  }

  function commitLine() {
    var typed = $('typing').value;
    var target = currentLine();

    if (!run.startedAt) return;
    if (typed.length < target.length) {
      flashHint('Type the whole line, then press Enter.');
      return;
    }

    var s = lineStats(typed, target);
    run.correctChars += s.correct;
    run.typedChars += s.typed;
    run.index++;
    $('typing').value = '';
    run.typedSoFar = '';

    if (run.index >= run.track.lines.length) {
      finishRun();
      return;
    }
    paintLine();
    $('typing').focus();
  }

  var hintTimer = null;
  function flashHint(msg) {
    var el = $('hint-msg');
    el.textContent = msg;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { el.textContent = ''; }, 1800);
  }

  // ----------------------------------------------------------------- result

  function finishRun() {
    run.finishedAt = Date.now();
    clearInterval(ticker);
    ticker = null;
    $('typing').disabled = true;

    var durationMs = run.finishedAt - run.startedAt;
    var minutes = durationMs / 60000;
    var wpm = (run.correctChars / 5) / minutes;
    var accuracy = accuracyPct();

    // The whole round stays in memory for inspection after the fact.
    window.TYPERIDER_LAST_RUN = {
      track: run.track.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      accuracy: accuracy,
      strokes: run.strokes,
      mistyped: run.mistyped,
      deletedCorrect: run.deletedCorrect,
      keystrokes: run.keystrokes
    };

    $('result-who').textContent = player + ' · ' + run.track.title;
    $('result-wpm').textContent = wpm.toFixed(1);
    $('result-acc').textContent = Math.round(accuracy) + '%';
    $('result-time').textContent = fmtTime(durationMs);
    $('result-chars').textContent = run.correctChars;
    $('result-mistakes').textContent = describeMistakes();
    $('result-mistakes').classList.toggle('is-clean', mistakeCount() === 0);
    $('result-badge').textContent = 'Sending your time…';
    $('result-board').innerHTML = '';
    show('stage-result');

    fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: player,
        wpm: Math.round(wpm * 10) / 10,
        accuracy: Math.round(accuracy * 10) / 10,
        track: run.track.id,
        durationMs: durationMs,
        chars: run.correctChars
      })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('result-badge').textContent = res.body.error || 'Your time could not be saved.';
          $('result-badge').classList.add('is-error');
          return;
        }
        $('result-badge').classList.remove('is-error');
        var b = res.body;
        $('result-badge').textContent = b.rank
          ? (b.improved ? 'New personal best — rank #' + b.rank + ' on the board.'
                        : 'Currently rank #' + b.rank + '. Your best still stands.')
          : b.full ? 'The board is full — beat the slowest rider on it to take a seat.'
          : (b.improved ? 'New personal best — keep pushing for the top ten.'
                        : 'Not your best run. Your record still stands.');
        renderMiniBoard(b.entries || []);
      })
      .catch(function () {
        $('result-badge').textContent = 'Offline — this run was not saved to the board.';
        $('result-badge').classList.add('is-error');
      });
  }

  /* Spell out where the missing accuracy went, so the number is not a verdict
     without an explanation. */
  function describeMistakes() {
    var parts = [];
    if (run.mistyped) {
      parts.push(run.mistyped + (run.mistyped === 1 ? ' wrong character' : ' wrong characters'));
    }
    if (run.deletedCorrect) {
      parts.push(run.deletedCorrect + ' correct ' +
        (run.deletedCorrect === 1 ? 'character' : 'characters') + ' deleted');
    }
    if (!parts.length) return 'Clean run — not a single mistake in ' + run.strokes + ' keystrokes.';
    return mistakeCount() + ' mistakes in ' + run.strokes + ' keystrokes · ' + parts.join(' · ');
  }

  function renderMiniBoard(entries) {
    if (!entries.length) return;
    var trackTitle = function (id) {
      var t = TRACKS.find(function (x) { return x.id === id; });
      return t ? t.title : id;
    };
    $('result-board').innerHTML =
      '<table class="rows"><thead><tr><th class="col-rank">#</th><th>Rider</th>' +
      '<th>Story</th><th class="col-num">WPM</th></tr></thead><tbody>' +
      entries.map(function (e) {
        var mine = e.name.toLowerCase() === player.toLowerCase();
        return '<tr' + (mine ? ' class="is-you"' : '') + '>' +
          '<td class="col-rank">' + e.rank + '</td>' +
          '<td class="name-cell">' + esc(e.name) + '</td>' +
          '<td><span class="track-pill">' + esc(trackTitle(e.track)) + '</span></td>' +
          '<td class="col-num"><b>' + e.wpm.toFixed(1) + '</b></td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ------------------------------------------------------------------ wiring

  function submitName() {
    var value = $('name').value.trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(value)) {
      $('name-error').textContent = 'Pick 2–16 characters: letters, digits, spaces, . _ or -';
      return;
    }
    player = value;
    store.set('typerider.name', player);
    $('name-error').textContent = '';
    show('stage-track');
  }

  $('name').value = player;
  renderSuggestions();
  renderPicker();

  $('name-next').addEventListener('click', submitName);
  $('name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitName(); }
  });
  $('back-name').addEventListener('click', function () { show('stage-name'); });

  $('typing').addEventListener('input', function () {
    if (!run) return;
    if (!run.startedAt) {
      run.startedAt = Date.now();
      ticker = setInterval(tick, 200);
    }
    trackInput($('typing').value);
    paintLine();
    tick();
  });

  $('typing').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (run && run.startedAt) logKey('enter', 'Enter', $('typing').value.length, false);
      commitLine();
    }
  });

  $('next-line').addEventListener('click', commitLine);
  $('prompt').addEventListener('click', function () { $('typing').focus(); });

  $('quit').addEventListener('click', function () {
    clearInterval(ticker);
    ticker = null;
    run = null;
    show('stage-track');
  });

  $('again').addEventListener('click', function () { show('stage-track'); });

  // Every visit starts at the name stage, prefilled if we have seen this rider.
  show('stage-name');
})();
