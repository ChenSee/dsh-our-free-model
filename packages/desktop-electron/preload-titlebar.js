'use strict'
/**
 * 自定义标题栏的最小桥：只暴露窗口操作，不暴露任何 Node 能力。
 * 仅当页面 origin 与加载地址一致时由主进程注入的标题栏脚本调用。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ofmTitlebarApi', {
  minimize: () => ipcRenderer.invoke('ofm:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('ofm:toggle-maximize'),
  hide: () => ipcRenderer.invoke('ofm:hide'),
  startDrag: () => ipcRenderer.invoke('ofm:start-drag'),
  isMaximized: () => ipcRenderer.invoke('ofm:is-maximized'),
})

// 启动失败页用：重试 / 退出都走主进程，页面本身没有任何本地能力。
// 同一个 preload 同时挂在主窗口上无副作用（主页面不会读 ofmError）。
contextBridge.exposeInMainWorld('ofmError', {
  retry: () => ipcRenderer.invoke('ofm:error-retry'),
  quit: () => ipcRenderer.invoke('ofm:error-quit'),
})
