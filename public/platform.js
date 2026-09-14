/* 平台适配层：浏览器（HTTP API + SSE）与 Tauri（IPC + 事件）共用同一套 UI */

(() => {
  const isTauri = Boolean(window.__TAURI__);

  async function httpJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = (await res.json()).error ?? message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }
    return res.json();
  }

  const httpPlatform = {
    kind: 'http',
    canAutostart: false,

    getState: () => httpJson('/api/state'),
    getTweets: (params) => {
      const qs = new URLSearchParams();
      qs.set('limit', String(params.limit ?? 60));
      qs.set('offset', String(params.offset ?? 0));
      if (params.resetOnly) qs.set('resetOnly', '1');
      if (params.q) qs.set('q', params.q);
      if (params.hours) qs.set('hours', String(params.hours));
      return httpJson(`/api/tweets?${qs}`);
    },
    getAlerts: (limit = 50) => httpJson(`/api/alerts?limit=${limit}`),
    control: (action) =>
      httpJson('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }),
    updateConfig: (patch) =>
      httpJson('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    rescan: () => httpJson('/api/rescan', { method: 'POST' }),
    simulate: (text) =>
      httpJson('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    testNotify: () => httpJson('/api/test-notify', { method: 'POST' }),
    xLogin: async () => ({ ok: false, unsupported: true }),
    testAi: (text) =>
      httpJson('/api/test-ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    exportData: async () => {
      window.location.href = '/api/export';
      return { ok: true };
    },
    openExternal: (url) => {
      window.open(url, '_blank', 'noopener');
      return { ok: true };
    },
    setAutostart: async () => ({ ok: false, unsupported: true }),
    subscribe(handlers) {
      const source = new EventSource('/api/events');
      for (const [event, handler] of Object.entries(handlers)) {
        source.addEventListener(event, (e) => handler(JSON.parse(e.data)));
      }
      source.onerror = () => handlers.error?.();
      return () => source.close();
    },
  };

  const { invoke } = window.__TAURI__?.core ?? {};
  const { listen } = window.__TAURI__?.event ?? {};

  const tauriPlatform = {
    kind: 'tauri',
    canAutostart: true,

    getState: () => invoke('get_state'),
    getTweets: (params) =>
      invoke('get_tweets', {
        limit: params.limit ?? 60,
        offset: params.offset ?? 0,
        resetOnly: Boolean(params.resetOnly),
        q: params.q ?? '',
        hours: params.hours ?? 0,
      }),
    getAlerts: (limit = 50) => invoke('get_alerts', { limit }),
    control: (action) => invoke('control', { action }),
    updateConfig: (patch) => invoke('update_config', { patch }),
    rescan: () => invoke('rescan'),
    simulate: (text) => invoke('simulate', { text }),
    testNotify: () => invoke('test_notify'),
    xLogin: () => invoke('open_x_login'),
    testAi: (text) => invoke('test_ai', { text }),
    exportData: () => invoke('export_data'),
    openExternal: (url) => invoke('open_external', { url }),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    subscribe(handlers) {
      const unlisteners = [];
      for (const [event, handler] of Object.entries(handlers)) {
        listen(event, (e) => handler(e.payload)).then((un) => unlisteners.push(un));
      }
      return () => unlisteners.forEach((un) => un());
    },
  };

  window.Platform = isTauri ? tauriPlatform : httpPlatform;
})();
