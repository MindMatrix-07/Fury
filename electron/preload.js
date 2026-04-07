const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('furyDesktop', {
  isDesktop: true,
  openPdf: () => ipcRenderer.invoke('fury:open-pdf'),
  savePdf: (defaultPath, bytes) => ipcRenderer.invoke('fury:save-pdf', { defaultPath, bytes }),
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('fury:menu-action', listener);
    return () => ipcRenderer.removeListener('fury:menu-action', listener);
  }
});
