(function (root) {
  'use strict';
  const STORAGE_KEYS = Object.freeze(['backlogSpaces', 'backlogKey', 'backlogSpaceUrl']);
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
  const keyValue = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';

  function spaceOrigin(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)\/?$/i.test(text)) return '';
    try {return new URL(text).origin;} catch {return '';}
  }

  function list(settings = {}) {
    if (!settings || typeof settings !== 'object') return [];
    if (!Array.isArray(settings.backlogSpaces)) {
      const origin = spaceOrigin(settings.backlogSpaceUrl);
      const apiKey = keyValue(settings.backlogKey);
      return origin && apiKey ? [{origin, keys: [{id: 'legacy', label: '既存のAPIキー', apiKey}], activeKeyId: 'legacy'}] : [];
    }
    const spaces = new Map();
    settings.backlogSpaces.forEach((entry, spaceIndex) => {
      const origin = spaceOrigin(entry?.origin);
      if (!origin || !Array.isArray(entry.keys)) return;
      let space = spaces.get(origin);
      if (!space) {
        space = {origin, keys: [], activeKeyId: ''};
        spaces.set(origin, space);
      }
      entry.keys.forEach((key, keyIndex) => {
        const apiKey = keyValue(key?.apiKey);
        if (!apiKey) return;
        let normalized = space.keys.find(saved => saved.apiKey === apiKey);
        if (!normalized) {
          let id = validId(key.id) ? key.id : `key-${spaceIndex + 1}-${keyIndex + 1}`;
          const base = id;
          let suffix = 1;
          while (space.keys.some(saved => saved.id === id)) {
            const ending = `-${++suffix}`;
            id = `${base.slice(0, 128 - ending.length)}${ending}`;
          }
          const label = typeof key.label === 'string' ? key.label.trim().slice(0, 100) : '';
          normalized = {id, label: label || `APIキー ${space.keys.length + 1}`, apiKey};
          space.keys.push(normalized);
        }
        if (!space.activeKeyId && validId(entry.activeKeyId) && key.id === entry.activeKeyId) space.activeKeyId = normalized.id;
      });
    });
    return [...spaces.values()].filter(space => space.keys.length).map(space => ({...space,
      activeKeyId: space.activeKeyId || space.keys[0].id}));
  }

  function resolve(settings, requestedOrigin) {
    const spaces = list(settings);
    const origin = requestedOrigin === undefined ? spaces[0]?.origin : spaceOrigin(requestedOrigin);
    const space = spaces.find(entry => entry.origin === origin);
    const key = space?.keys.find(entry => entry.id === space.activeKeyId);
    return key ? {origin, apiKey: key.apiKey, keyId: key.id, label: key.label} : null;
  }

  root.BacklogCredentials = Object.freeze({STORAGE_KEYS, spaceOrigin, list, resolve});
})(globalThis);
