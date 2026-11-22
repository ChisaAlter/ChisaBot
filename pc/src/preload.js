"use strict";
/* 本机页面（登录页、审批弹窗、本机确认、离线页）的桥。主进程还会核对每次调用来自 src/ui/ 下的本机页面。 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "state:get",
  "login:probe",
  "login:submit",
  "login:forget",
  "login:open",
  "paused:set",
  "chat:retry",
  "approval:current",
  "approval:decide",
  "confirm:current",
  "confirm:answer",
  "update:current",
  "update:answer",
  "update:download-latest",
  "update:retry",
  "dialog:fit",
  "window:local",
]);

contextBridge.exposeInMainWorld("chisa", {
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`未知操作 ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  onState(callback) {
    const listener = (_event, kind) => callback(kind);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onUpdateState(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  onWindowMaximized(callback) {
    const listener = (_event, value) => callback(Boolean(value));
    ipcRenderer.on("window:local-maximized", listener);
    return () => ipcRenderer.removeListener("window:local-maximized", listener);
  },
});
