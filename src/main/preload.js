'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge. The renderer never touches Node, the filesystem, or the
// AI token directly — everything goes through these typed calls into main.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  profiles: {
    list: () => invoke('profiles:list'),
    create: (name, color, avatar) => invoke('profiles:create', { name, color, avatar }),
    rename: (id, name) => invoke('profiles:rename', { id, name }),
    update: (id, patch) => invoke('profiles:update', { id, patch }),
    remove: (id) => invoke('profiles:delete', id),
    switch: (id) => invoke('profiles:switch', id)
  },
  entries: {
    forDate: (date) => invoke('entries:forDate', date),
    inRange: (start, end) => invoke('entries:inRange', { start, end }),
    add: (entry) => invoke('entries:add', entry),
    update: (entry) => invoke('entries:update', entry),
    remove: (id) => invoke('entries:delete', id)
  },
  ai: {
    estimate: (text) => invoke('ai:estimate', text),
    // async: estimates `text` and applies the result to an existing entry in a
    // specific profile; resolves to { ok, data: updatedEntry }.
    estimateEntry: (profileId, entryId, text) => invoke('ai:estimateEntry', { profileId, entryId, text }),
    weekInsight: (agg) => invoke('ai:weekInsight', agg),
    test: (overrideAi) => invoke('ai:test', overrideAi)
  },
  hints: {
    add: (list) => invoke('hints:add', list),
    list: () => invoke('hints:list')
  },
  data: {
    export: () => invoke('data:export'),
    import: () => invoke('data:import')
  },
  updates: {
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    getState: () => invoke('update:state'),
    // main -> renderer push of update lifecycle state
    onStatus: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('update:status', l); return () => ipcRenderer.removeListener('update:status', l); }
  },
  app: {
    info: () => invoke('app:info')
  }
});
