(function (global) {
  'use strict';
  const MATCHES = ['https://*.backlog.com/*', 'https://*.backlog.jp/*', 'https://*.backlogtool.com/*'];
  function isIssue(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password
        && /^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i.test(parsed.hostname)
        && /^\/view\/[A-Z0-9_]+-\d+\/?$/i.test(parsed.pathname);
    } catch {return false;}
  }
  function install(chrome) {
    if (!chrome.tabs?.onActivated || !chrome.scripting) return;
    const pending = new Map();
    function recover(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
      if (pending.has(tabId)) return pending.get(tabId);
      const operation = (async () => {
        let tab = await chrome.tabs.get(tabId);
        if (!isIssue(tab.url) || tab.status === 'loading' || tab.discarded) return;
        try {
          const response = await chrome.tabs.sendMessage(tabId, {type: 'BACKLOG_AI_PING'}, {frameId: 0});
          if (response?.ok && response.version === 1) return;
        } catch { /* A stale or discarded content script can be installed again. */ }
        tab = await chrome.tabs.get(tabId);
        if (!isIssue(tab.url) || tab.status === 'loading' || tab.discarded) return;
        const target = {tabId, frameIds: [0]};
        await chrome.scripting.insertCSS({target, files: ['content.css']});
        await chrome.scripting.executeScript({target, files: ['panel-layout.js', 'vendor/marked/marked.umd.js', 'chat-markdown.js', 'content.js']});
      })().catch(() => { /* Closed tabs and pages still loading retry on the next activation. */ });
      pending.set(tabId, operation);
      return operation.finally(() => {if (pending.get(tabId) === operation) pending.delete(tabId);});
    }
    async function activeTabs(windowId) {
      try {
        const tabs = await chrome.tabs.query({active: true, url: MATCHES, ...(Number.isInteger(windowId) && windowId >= 0 ? {windowId} : {})});
        await Promise.all(tabs.map(tab => recover(tab.id)));
      } catch { /* Browser startup/window shutdown may race with tab discovery. */ }
    }
    chrome.tabs.onActivated.addListener(({tabId}) => {void recover(tabId);});
    chrome.tabs.onUpdated.addListener((tabId, change) => {if (change.status === 'complete') void recover(tabId);});
    chrome.windows?.onFocusChanged.addListener(windowId => {if (windowId >= 0) void activeTabs(windowId);});
    chrome.runtime.onStartup.addListener(() => {void activeTabs();});
    chrome.runtime.onInstalled.addListener(() => {void activeTabs();});
    return {recover};
  }
  global.BacklogTabRecovery = Object.freeze({install, isIssue});
})(globalThis);
