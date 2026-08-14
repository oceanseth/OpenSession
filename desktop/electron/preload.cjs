const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  deviceStart: (clientId) => ipcRenderer.invoke('auth:device-start', clientId),
  devicePoll: (clientId, deviceCode) => ipcRenderer.invoke('auth:device-poll', { clientId, deviceCode }),
  runBench: (params) => ipcRenderer.invoke('bench:run', params),
  saveReport: (report) => ipcRenderer.invoke('report:save', report),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onBenchProgress: (cb) => {
    const listener = (_e, message) => cb(message);
    ipcRenderer.on('bench:progress', listener);
    return () => ipcRenderer.removeListener('bench:progress', listener);
  },
});
