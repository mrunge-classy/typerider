/* Homepage: render the leaderboard and the story cards. */
(function () {
  'use strict';

  var board = document.getElementById('board');
  var tracksEl = document.getElementById('tracks');
  var factPlayers = document.getElementById('fact-players');
  var lastName = null;
  try { lastName = localStorage.getItem('typerider.name'); } catch (e) { /* private mode */ }

  var BOARD = window.TYPERIDER_BOARD;
  var esc = BOARD.esc;

  // The board can be reset, so "fastest rider" only means fastest since this
  // board started — say when that was rather than implying an all-time record.
  function startedLine(data) {
    var when = data.board && data.board.createdAt;
    if (!when) return '';
    var text = new Date(when).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    return '<div class="board-meta">Board started ' + esc(text) + '</div>';
  }

  function trackMeta(t) {
    return t.lines.length + ' lines · ' + t.lines.join(' ').length + ' characters';
  }

  // Buttons, not articles: the whole card opens the story, and a button gets
  // keyboard and screen-reader behaviour for free.
  function renderTracks() {
    if (!tracksEl) return;
    tracksEl.innerHTML = (window.TYPERIDER_TRACKS || []).map(function (t) {
      return '<button class="card track-card" type="button" data-track="' + esc(t.id) + '">' +
        '<span class="lang">' + esc(t.langLabel) + '</span>' +
        '<h3>' + esc(t.title) + '</h3>' +
        '<p>' + esc(t.blurb) + '</p>' +
        '<span class="count">' + trackMeta(t) + '<span class="read">Read story</span></span>' +
        '</button>';
    }).join('');

    tracksEl.addEventListener('click', function (ev) {
      var card = ev.target.closest('.track-card');
      if (card) openStory(card.dataset.track);
    });
  }

  /* ------------------------------------------------------------ story reader */

  var modal = document.getElementById('story-modal');
  var closeBtn = document.getElementById('story-close');
  var sheet = modal && modal.querySelector('.story-sheet');
  var lastFocus = null;

  // Only claim there is more to read while there actually is: the fade would
  // otherwise sit over the final line of a story that already fits.
  function syncScrollHint() {
    if (!sheet || modal.hidden) return;
    var body = document.getElementById('story-text');
    var left = body.scrollHeight - body.clientHeight - body.scrollTop;
    sheet.classList.toggle('has-more', left > 4);
  }

  function openStory(id) {
    var t = (window.TYPERIDER_TRACKS || []).find(function (x) { return x.id === id; });
    if (!t || !modal) return;

    document.getElementById('story-lang').textContent = t.langLabel;
    document.getElementById('story-title').textContent = t.title;
    document.getElementById('story-meta').textContent = trackMeta(t);

    // One paragraph per line: that is the shape you type it in, and it reads
    // better than a wall of text on a phone.
    var body = document.getElementById('story-text');
    body.lang = t.lang;
    body.innerHTML = t.lines.map(function (line) {
      return '<p>' + esc(line) + '</p>';
    }).join('');
    body.scrollTop = 0;

    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('is-locked');
    closeBtn.focus();
    syncScrollHint(); // after unhiding: a hidden sheet measures as zero
  }

  function closeStory() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('is-locked');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  if (modal) {
    closeBtn.addEventListener('click', closeStory);
    document.getElementById('story-text').addEventListener('scroll', syncScrollHint, { passive: true });
    // A phone toolbar sliding away, or a rotation, changes what fits.
    window.addEventListener('resize', syncScrollHint);
    modal.addEventListener('click', function (ev) {
      if (ev.target.hasAttribute('data-close-story')) closeStory();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeStory(); return; }
      // The X is the sheet's only focusable element, so Tab stays on it
      // instead of wandering into the page behind the overlay.
      if (ev.key === 'Tab' && !modal.hidden) {
        ev.preventDefault();
        closeBtn.focus();
      }
    });
  }

  /* ------------------------------------------------------------ the board */

  // Which board is on screen. Ranking happens server-side per class, so this is
  // a query parameter rather than a filter over rows already fetched -- a
  // mobile rider sitting 30th overall still has to be able to top their own
  // board.
  var view = null; // null = every run, regardless of class

  var VIEWS = [
    { id: null, label: 'All runs' },
    { id: 'mobile', label: 'Mobile' },
    { id: 'desktop', label: 'Desktop' }
  ];

  function renderFilter(counts) {
    return '<div class="board-filter" role="group" aria-label="Which board to show">' +
      VIEWS.map(function (v) {
        var n = !v.id ? null : (counts && counts[v.id]) || 0;
        return '<button type="button" class="board-tab' + (v.id === view ? ' is-on' : '') +
          '" data-view="' + (v.id || '') + '"' + (v.id === view ? ' aria-current="true"' : '') + '>' +
          v.label + (n === null ? '' : ' <span class="n">' + n + '</span>') +
          '</button>';
      }).join('') +
      '</div>';
  }

  // Said once, on the board itself, rather than in a tooltip nobody opens: the
  // split is by what was typed on, and it is evidence rather than proof.
  function filterNote(counts) {
    var stray = (counts && counts.unknown) || 0;
    var note = view === null
      ? 'Mobile and desktop runs are scored separately — a touchscreen keyboard is slower than a physical one.'
      : 'Runs are filed by what the typing looked like, not by what the browser calls itself. It can be fooled.';
    if (view === null && stray) {
      note += ' ' + stray + (stray === 1 ? ' run predates' : ' runs predate') +
        ' the split and sit outside both boards.';
    }
    return '<div class="board-note">' + esc(note) + '</div>';
  }

  function emptyMessage() {
    if (view === 'mobile') return 'No phone runs yet — the mobile board is wide open.';
    if (view === 'desktop') return 'No keyboard runs yet — the desktop board is wide open.';
    return 'The board is wide open — the first run takes first place.';
  }

  function renderBoard(data) {
    var entries = data.entries || [];
    var counts = data.counts;
    if (factPlayers) factPlayers.textContent = data.players || 0;

    if (!entries.length) {
      board.innerHTML = renderFilter(counts) +
        '<div class="board-empty">' +
        '<p><strong>No times yet.</strong></p>' +
        '<p>' + esc(emptyMessage()) + '</p></div>' +
        filterNote(counts) + startedLine(data);
      return;
    }

    var champ = entries[0];
    var html = renderFilter(counts) +
      '<div class="board-champion">' +
      '<div class="champion-medal" aria-hidden="true">★</div>' +
      '<div class="champion-body">' +
        '<div class="label">' + (view ? esc(BOARD.deviceLabel(view)) + ' champion' : 'Fastest rider') + '</div>' +
        '<div class="who">' + esc(champ.name) + '</div>' +
      '</div>' +
      '<div class="champion-score"><b>' + champ.wpm.toFixed(1) + '</b><span>WPM · ' +
        champ.accuracy.toFixed(0) + '% accuracy</span></div>' +
    '</div>';

    // The class column earns its place only on the combined view; on a filtered
    // board every row would carry the same pill.
    html += BOARD.table(entries, {
      columns: view ? ['rank', 'name', 'track', 'accuracy', 'wpm']
                    : ['rank', 'name', 'track', 'device', 'accuracy', 'wpm'],
      you: lastName
    }) + filterNote(counts) + startedLine(data);

    board.innerHTML = html;
  }

  function loadBoard() {
    // No `limit` here on purpose: how many rows the board shows is a server-side
    // setting an admin can change.
    fetch('/api/leaderboard' + (view ? '?device=' + encodeURIComponent(view) : ''))
      .then(function (r) { return r.json(); })
      .then(renderBoard)
      .catch(function () {
        board.innerHTML = '<div class="board-empty">The board could not be loaded right now.</div>';
      });
  }

  board.addEventListener('click', function (ev) {
    var tab = ev.target.closest('.board-tab');
    if (!tab) return;
    var next = tab.dataset.view || null;
    if (next === view) return;
    view = next;
    loadBoard();
  });

  renderTracks();
  loadBoard();
})();
