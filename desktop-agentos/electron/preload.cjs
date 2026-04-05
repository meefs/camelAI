const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  sendEvent: (event) => ipcRenderer.send('desktop:send', event),
  reportReady: (payload) => ipcRenderer.send('desktop:ready', payload),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('desktop:event', handler);
    return () => {
      ipcRenderer.removeListener('desktop:event', handler);
    };
  },
});
