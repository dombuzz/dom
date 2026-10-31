// Erklär-Tooltips für Kacheln mit data-tip: Maus (Hover), Tastatur (Fokus) und Antippen auf dem Handy
(function () {
  'use strict';
  var tip = document.createElement('div');
  tip.className = 'dbz-tip'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  var cur = null;
  function place(el) {
    var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8), y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function show(el) { cur = el; tip.textContent = el.getAttribute('data-tip'); tip.classList.add('show'); place(el); }
  function hide() { tip.classList.remove('show'); cur = null; }
  var find = function (t) { return t && t.closest ? t.closest('[data-tip]') : null; };
  document.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var el = find(e.target); if (el === cur) return; el ? show(el) : hide();
  });
  document.addEventListener('click', function (e) { var el = find(e.target); el ? show(el) : hide(); });
  document.addEventListener('focusin', function (e) { var el = find(e.target); el ? show(el) : hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
})();
