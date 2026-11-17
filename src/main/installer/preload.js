const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('setup', {
  minimize: invoke('win:minimize'), close: invoke('win:close'),
  info: invoke('setup:info'), scan: invoke('setup:scan'), dirInfo: invoke('setup:dirInfo'), browse: invoke('setup:browse'),
  install: invoke('setup:install'), finish: invoke('setup:finish'), openExternal: invoke('setup:openExternal'),
  onProgress: (cb) => ipcRenderer.on('setup:progress', (_e, d) => cb(d))
});
