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
