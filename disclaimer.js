// Disclaimer shown on first use; the app stays covered until the user accepts.
// Load with <script src="disclaimer.js" data-app="Name"></script> before the app's scripts.
// The apps share one origin (jlblan2.github.io), so acceptance is remembered per app.
// window.showDisclaimer() shows it again (e.g. from Settings).
(function () {
  const script = document.currentScript;
  const app = (script && script.dataset.app) || document.title || 'This application';
  const KEY = 'disclaimer.' + app + '.v1';

  const TEXT = [
    app + ' is provided "as is", without warranty of any kind, express or implied, including ' +
      'any warranty of accuracy, reliability or fitness for a particular purpose.',
    'N. Tesla, Inc. and the developer assume no responsibility or liability to the user of this ' +
      'application, or to anyone else, for its use, or for any loss, damage, injury or death ' +
      'arising from its use, from the information it provides, or from being unable to use it.',
    'The user is responsible for using due diligence: checking all information against official ' +
      'sources, charts, forecasts and equipment, and using sound judgment. The user assumes all ' +
      'risk of using this application.',
  ];

  function accepted() {
    try { return localStorage.getItem(KEY) === 'accepted'; } catch (e) { return false; }
  }

  function show(mustAccept) {
    if (document.getElementById('disclaimerOverlay')) return;
    const css = document.createElement('style');
    css.textContent =
      '#disclaimerOverlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.85);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;' +
      'font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '#disclaimerOverlay .dbox{background:#11161d;color:#e8edf3;border:1px solid #3a4655;border-radius:12px;' +
      'max-width:520px;width:100%;max-height:100%;overflow:auto;padding:20px;box-sizing:border-box}' +
      '#disclaimerOverlay h2{margin:0 0 12px;font-size:20px;color:#ffcc4d}' +
      '#disclaimerOverlay p{margin:0 0 12px}' +
      '#disclaimerOverlay button{display:block;width:100%;margin-top:8px;padding:14px;font-size:17px;' +
      'font-weight:600;border:0;border-radius:10px;background:#1f7a3d;color:#fff;cursor:pointer}' +
      '@media print{#disclaimerOverlay{display:none}}';
    const overlay = document.createElement('div');
    overlay.id = 'disclaimerOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'disclaimerTitle');
    const box = document.createElement('div');
    box.className = 'dbox';
    const h = document.createElement('h2');
    h.id = 'disclaimerTitle';
    h.textContent = 'Disclaimer';
    box.appendChild(h);
    TEXT.forEach((t) => { const p = document.createElement('p'); p.textContent = t; box.appendChild(p); });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = mustAccept ? 'I understand and accept' : 'Close';
    btn.addEventListener('click', () => {
      if (mustAccept) { try { localStorage.setItem(KEY, 'accepted'); } catch (e) { /* asked again next time */ } }
      overlay.remove();
      css.remove();
    });
    box.appendChild(btn);
    overlay.appendChild(box);
    document.head.appendChild(css);
    document.body.appendChild(overlay);
    btn.focus();
  }

  window.showDisclaimer = () => show(!accepted());

  if (!accepted()) {
    if (document.body) show(true);
    else document.addEventListener('DOMContentLoaded', () => show(true));
  }
})();
