/* Typerider · what the rider actually typed on.

   The two boards are split by input method, not by device identity: a glass
   keyboard is slower than a physical one, and that -- not the shape of the
   hardware -- is what makes the scores incomparable. A phone paired with a
   Bluetooth keyboard therefore belongs on the desktop board, and a laptop with
   a touchscreen belongs on the desktop board too, which is what falls out of
   watching the input rather than sniffing the User-Agent.

   This file only *counts what happened* during the run. It deliberately does
   not decide anything: the classification lives on the server, which can also
   see request headers the page cannot rewrite after the fact. Everything here
   is self-reported and therefore forgeable -- it raises the cost of faking a
   mobile score, it does not make it impossible, and nothing built on top of it
   should be presented to a player as proof. */
(function () {
  'use strict';

  function media(query) {
    try { return window.matchMedia(query).matches; } catch (e) { return false; }
  }

  /* Watch one field for the length of a run. Counters are plain integers, and
     `report()` is what gets posted with the score. */
  function watch(el) {
    var counts = { keyStrokes: 0, touchStrokes: 0, pointerTouch: 0, pointerMouse: 0 };

    // Set by a physical key and cleared by the input event it produces, so an
    // `input` with nothing pending is one that no physical key accounts for.
    var physicalPending = false;

    function onKeyDown(ev) {
      // A physical keyboard reports which key was pressed -- `code` is the
      // position on the board ("KeyA"), independent of layout. Software
      // keyboards leave it empty and often send the whole line as one
      // composition, which is exactly the difference being measured here.
      if (typeof ev.code === 'string' && ev.code !== '') {
        counts.keyStrokes++;
        physicalPending = true;
      }
    }

    function onInput() {
      // Text arrived with no physical key behind it: a software keyboard, an
      // IME composition, or a paste. The server requires a coarse pointer
      // alongside this before it will read it as touch, which is what keeps a
      // right-click paste on a desktop from looking like a phone.
      if (!physicalPending) counts.touchStrokes++;
      physicalPending = false;
    }

    function onPointerDown(ev) {
      if (ev.pointerType === 'touch') counts.pointerTouch++;
      else if (ev.pointerType === 'mouse') counts.pointerMouse++;
    }

    function onTouchStart() { counts.pointerTouch++; }

    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('input', onInput);
    if (window.PointerEvent) el.addEventListener('pointerdown', onPointerDown);
    else el.addEventListener('touchstart', onTouchStart, { passive: true });

    return {
      reset: function () {
        counts.keyStrokes = 0;
        counts.touchStrokes = 0;
        counts.pointerTouch = 0;
        counts.pointerMouse = 0;
        physicalPending = false;
      },

      // Capability signals are read at report time rather than at load: a
      // tablet docked mid-session genuinely changes answer.
      report: function () {
        return {
          keyStrokes: counts.keyStrokes,
          touchStrokes: counts.touchStrokes,
          pointerTouch: counts.pointerTouch,
          pointerMouse: counts.pointerMouse,
          maxTouchPoints: navigator.maxTouchPoints || 0,
          coarsePointer: media('(pointer: coarse)'),
          noHover: media('(hover: none)')
        };
      }
    };
  }

  window.TYPERIDER_INPUT = { watch: watch };
})();
