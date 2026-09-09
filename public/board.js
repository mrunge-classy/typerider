/* Typerider · one leaderboard table, rendered in two places.

   The homepage board and the mini board on the result screen show different
   columns of the same rows. They used to be two copies of the same markup and
   the same trackTitle lookup, which is how they drifted; adding the device
   column would have made a third. */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function trackTitle(id) {
    var t = (window.TYPERIDER_TRACKS || []).find(function (x) { return x.id === id; });
    return t ? t.title : id;
  }

  // Runs recorded before the split have no class and are not guessed into one.
  var DEVICE_LABELS = { mobile: 'Mobile', desktop: 'Desktop' };

  function deviceLabel(device) {
    return DEVICE_LABELS[device] || 'Unclassified';
  }

  /* Columns are named rather than positional so the two callers can ask for
     different sets without either of them owning the markup. */
  var COLUMNS = {
    rank:     { head: '#',        cls: 'col-rank', cell: function (e) { return e.rank; } },
    name:     { head: 'Rider',    cls: 'name-cell', cell: function (e, o) {
                  return esc(e.name) + (o.mine ? ' <span class="track-pill">you</span>' : '');
                } },
    track:    { head: 'Story',    cls: 'col-track', cell: function (e) {
                  return '<span class="track-pill">' + esc(trackTitle(e.track)) + '</span>';
                } },
    device:   { head: 'Typed on', cls: 'col-device', cell: function (e) {
                  return '<span class="device-pill is-' + esc(e.device || 'unknown') + '">' +
                    esc(deviceLabel(e.device)) + '</span>';
                } },
    accuracy: { head: 'Accuracy', cls: 'col-num col-accuracy', cell: function (e) {
                  return e.accuracy.toFixed(0) + '%';
                } },
    wpm:      { head: 'WPM',      cls: 'col-num col-wpm', cell: function (e) {
                  return '<b>' + e.wpm.toFixed(1) + '</b>';
                } }
  };

  /* `you` is matched case-insensitively on the name alone: the same rider can
     hold a row on both boards, and both should light up as theirs. */
  function table(entries, opts) {
    var options = opts || {};
    var cols = (options.columns || ['rank', 'name', 'track', 'accuracy', 'wpm'])
      .map(function (key) { return COLUMNS[key]; })
      .filter(Boolean);
    var you = options.you ? String(options.you).toLowerCase() : null;

    return '<table class="rows"><thead><tr>' +
      cols.map(function (c) {
        return '<th' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.head + '</th>';
      }).join('') +
      '</tr></thead><tbody>' +
      entries.map(function (e) {
        var mine = !!you && e.name.toLowerCase() === you;
        return '<tr' + (mine ? ' class="is-you"' : '') + '>' +
          cols.map(function (c) {
            return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' +
              c.cell(e, { mine: mine }) + '</td>';
          }).join('') +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  window.TYPERIDER_BOARD = {
    esc: esc,
    trackTitle: trackTitle,
    deviceLabel: deviceLabel,
    table: table
  };
})();
