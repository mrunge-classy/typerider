/* Homepage: render the leaderboard and the story cards. */
(function () {
  'use strict';

  var board = document.getElementById('board');
  var tracksEl = document.getElementById('tracks');
  var factPlayers = document.getElementById('fact-players');
  var lastName = null;
  try { lastName = localStorage.getItem('typerider.name'); } catch (e) { /* private mode */ }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function trackTitle(id) {
    var t = (window.TYPERIDER_TRACKS || []).find(function (x) { return x.id === id; });
    return t ? t.title : id;
  }

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

  function renderBoard(data) {
    var entries = data.entries || [];
    if (factPlayers) factPlayers.textContent = data.players || 0;

    if (!entries.length) {
      board.innerHTML = '<div class="board-empty">' +
        '<p><strong>No times yet.</strong></p>' +
        '<p>The board is wide open — the first run takes first place.</p></div>' +
        startedLine(data);
      return;
    }

    var champ = entries[0];
    var html = '<div class="board-champion">' +
      '<div class="champion-medal" aria-hidden="true">★</div>' +
      '<div class="champion-body">' +
        '<div class="label">Fastest rider</div>' +
        '<div class="who">' + esc(champ.name) + '</div>' +
      '</div>' +
      '<div class="champion-score"><b>' + champ.wpm.toFixed(1) + '</b><span>WPM · ' +
        champ.accuracy.toFixed(0) + '% accuracy</span></div>' +
    '</div>';

    html += '<table class="rows"><thead><tr>' +
      '<th class="col-rank">#</th><th>Rider</th><th>Story</th>' +
      '<th class="col-num">Accuracy</th><th class="col-num">WPM</th>' +
      '</tr></thead><tbody>' +
      entries.map(function (e) {
        var mine = lastName && e.name.toLowerCase() === lastName.toLowerCase();
        return '<tr' + (mine ? ' class="is-you"' : '') + '>' +
          '<td class="col-rank">' + e.rank + '</td>' +
          '<td class="name-cell">' + esc(e.name) + (mine ? ' <span class="track-pill">you</span>' : '') + '</td>' +
          '<td><span class="track-pill">' + esc(trackTitle(e.track)) + '</span></td>' +
          '<td class="col-num">' + e.accuracy.toFixed(0) + '%</td>' +
          '<td class="col-num"><b>' + e.wpm.toFixed(1) + '</b></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>' +
      startedLine(data);

    board.innerHTML = html;
  }

  renderTracks();

  // No `limit` here on purpose: how many rows the board shows is a server-side
  // setting an admin can change.
  fetch('/api/leaderboard')
    .then(function (r) { return r.json(); })
    .then(renderBoard)
    .catch(function () {
      board.innerHTML = '<div class="board-empty">The board could not be loaded right now.</div>';
    });
})();
