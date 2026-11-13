'use strict';
(function () {
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { viewer: 'builtin', webUrl: 'https://klepo0.github.io/TeXglass/' };
  const form = document.getElementById('form');
  const webUrl = document.getElementById('webUrl');
  const status = document.getElementById('status');
  let timer = null;

  function say(text) {
    status.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => (status.textContent = ''), 2500);
  }

  async function load() {
    const s = Object.assign({}, DEFAULTS, await api.storage.sync.get(DEFAULTS));
    form.elements.viewer.value = s.viewer;
    webUrl.value = s.webUrl;
  }

  async function save() {
    const viewer = form.elements.viewer.value || 'builtin';
    let url = webUrl.value.trim() || DEFAULTS.webUrl;
    if (!/^https?:\/\//i.test(url)) {
      say('The website address must start with https://');
      return;
    }
    await api.storage.sync.set({ viewer, webUrl: url });
    say('Saved.');
  }

  form.addEventListener('change', save);
  webUrl.addEventListener('focus', () => (form.elements.viewer.value = 'web'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  load();
})();
