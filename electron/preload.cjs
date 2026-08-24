// Preload script — runs in the renderer with Node access, before the app's
// page scripts. Exposes:
//   isElectron          — a flag so the app can tell it's running inside this
//                         Electron shell (and can render <webview> instead of
//                         <iframe> for the embed panel)
//   chooseWorkspace     — opens the native folder picker (main.cjs's
//                         'threadline:choose-workspace' handler) and resolves
//                         to the chosen absolute path, or null if cancelled
//   getCurrentUserEmail — resolves to the machine's git-config email
//                         (main.cjs's 'threadline:get-user' handler),
//                         auto-registering it in threadline.db, or null if
//                         git has no email configured
//   getGitStatus        — describes whether the given workspace folder can be
//                         synced ({ state: 'ready' | why-not, ahead, behind,
//                         dirty }); never throws
//   syncWorkspace       — pull --ff-only, commit everything, push. Resolves to
//                         { ok, reason?, committed?, pushed?, status }; a
//                         failure is a resolved value, not a rejection

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('threadlineDesktop', {
  isElectron: true,
  chooseWorkspace: () => ipcRenderer.invoke('threadline:choose-workspace'),
  getCurrentUserEmail: (workspaceDir) => ipcRenderer.invoke('threadline:get-user', workspaceDir),
  getGitStatus: (root) => ipcRenderer.invoke('threadline:git-status', root),
  syncWorkspace: (root, opts) => ipcRenderer.invoke('threadline:sync', root, opts),
  listGitHubAccounts: () => ipcRenderer.invoke('threadline:list-github-accounts'),
  getWorkspaceAccount: (workspaceDir) => ipcRenderer.invoke('threadline:get-workspace-account', workspaceDir),
  setWorkspaceAccount: (workspaceDir, username) => ipcRenderer.invoke('threadline:set-workspace-account', workspaceDir, username),
  validateAccounts: (workspaceDir) => ipcRenderer.invoke('threadline:validate-accounts', workspaceDir),
})
