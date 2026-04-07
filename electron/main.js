const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

let mainWindow = null;

function sendMenuAction(action) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('fury:menu-action', action);
    }
  });
}

async function openPdfDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const filePath = result.filePaths[0];
  const bytes = await fs.readFile(filePath);
  const stats = await fs.stat(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    lastModified: stats.mtimeMs,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

async function savePdfFile({ defaultPath, bytes }) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Annotated PDF',
    defaultPath,
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  await fs.writeFile(result.filePath, buffer);
  return {
    canceled: false,
    filePath: result.filePath
  };
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-pdf')
        },
        {
          label: 'Create Notebook',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('create-notebook')
        },
        {
          label: 'Export Annotated PDF',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('export-pdf')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#F7F6F3',
    title: 'Fury',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.mindmatrix.fury');
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('fury:open-pdf', openPdfDialog);
ipcMain.handle('fury:save-pdf', async (_event, payload) => savePdfFile(payload));
