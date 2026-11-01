/* Passwort-Sperre (nur im Browser, hält zufällige Besucher fern). Gleiches Passwort wie klima.dombuzz.ch. */
(function () {
  const PW_HASH = 'a0b1b45b994a0f01a9e597d0e994d11c44862c5dede45cb9ebd3deaf085d3060';
  const OKKEY = 'domOk';
  let ok = '';
  try { ok = localStorage.getItem(OKKEY) || ''; } catch (e) {}
  if (ok === PW_HASH) return;
  const st = document.createElement('style');
  st.textContent = 'body>*:not(#gate){visibility:hidden!important}body{overflow:hidden}'
    + '#gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;background:#111110;color:#eee;font:16px system-ui,sans-serif;visibility:visible}'
    + '#gate form{width:min(340px,90vw);padding:20px;background:#1d1d1b;border:1px solid #333;border-radius:14px}'
    + '#gate h1{font-size:1.3rem;margin:0 0 14px}#gate label{display:block;font-size:.85rem;color:#aaa;margin-bottom:4px}'
    + '#gate input{box-sizing:border-box;width:100%;padding:10px 12px;font:inherit;color:#eee;background:#111110;border:1px solid #444;border-radius:8px}'
    + '#gate button{margin-top:12px;padding:10px 16px;font:inherit;font-weight:600;color:#07090f;background:#f0952a;border:0;border-radius:8px;cursor:pointer}'
    + '#gate p{margin:10px 0 0;min-height:1.2em;font-size:.85rem;color:#f0952a}';
  document.documentElement.appendChild(st);
  async function hashPw(pw) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('klima.dombuzz.ch'), iterations: 150000 }, key, 256);
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function build() {
    const g = document.createElement('div');
    g.id = 'gate';
    g.innerHTML = '<form><h1>Anmelden</h1><label for="gpw">Passwort</label><input id="gpw" type="password" autocomplete="current-password" required><button type="submit">Anmelden</button><p role="alert"></p></form>';
    document.body.appendChild(g);
    const pw = g.querySelector('input'), msg = g.querySelector('p');
    pw.focus();
    g.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      let h = '';
      try { h = await hashPw(pw.value.trim()); } catch (err) { msg.textContent = 'Anmeldung in diesem Browser nicht möglich.'; return; }
      if (h === PW_HASH) {
        try { localStorage.setItem(OKKEY, h); } catch (err) {}
        g.remove(); st.remove();
        window.dispatchEvent(new Event('resize'));
      } else { msg.textContent = 'Passwort falsch.'; pw.select(); }
    });
  }
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
