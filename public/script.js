const socket = io();

const directoryList = document.getElementById('directoryList');
const currentPathLabel = document.getElementById('currentPathLabel');
const selectedFolderLabel = document.getElementById('selectedFolderLabel');
const upDirBtn = document.getElementById('upDirBtn');
const reloadDirBtn = document.getElementById('reloadDirBtn');
const startSessionBtn = document.getElementById('startSessionBtn');

const chatMeta = document.getElementById('chatMeta');
const aiStatus = document.getElementById('aiStatus');
const aiStatusText = document.getElementById('aiStatusText');
const aiStatusElapsed = document.getElementById('aiStatusElapsed');
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const fileTree = document.getElementById('fileTree');
const fileContent = document.getElementById('fileContent');
const filePathLabel = document.getElementById('filePathLabel');
const viewerRootLabel = document.getElementById('viewerRootLabel');
const reloadViewerBtn = document.getElementById('reloadViewerBtn');

const queueCountSpan = document.getElementById('queueCount');
const runningCountSpan = document.getElementById('runningCount');

let currentRelativePath = '';
let parentRelativePath = null;
let selectedRelativePath = '';
let activeSessionId = null;
let activeRequestId = null;
let activeRequestStartedAt = null;
let viewerRootRelativePath = '';
let viewerSelectedFile = '';
const viewerEntriesByDir = new Map();
const viewerOpenDirs = new Set(['']);
const pendingRequestIds = [];
const renderedMessageIds = new Set();
const streamingByRequestId = {};
let aiRespondingSince = null;
let aiStatusTimerId = null;
let sessionSyncTimerId = null;

socket.on('connect', () => {
  startSessionBtn.disabled = false;
  loadDirectories(currentRelativePath);
  fetchQueueStatus();
  if (!activeSessionId) {
    setAiStatus('idle', 'AI状態: セッション未開始');
  }
});

socket.on('disconnect', () => {
  startSessionBtn.disabled = true;
  disableMessageInput();
  setAiStatus('error', 'AI状態: サーバー未接続');
  stopSessionSyncPolling();
});

socket.on('task-queued', (data) => {
  if (data.queueStatus) {
    updateQueueStatus(data.queueStatus);
  }
});

socket.on('task-started', (data) => {
  if (data.queueStatus) {
    updateQueueStatus(data.queueStatus);
  }
});

socket.on('task-completed', (data) => {
  if (data.queueStatus) {
    updateQueueStatus(data.queueStatus);
  }
});

socket.on('chat-message', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId || !payload.message) {
    return;
  }
  if (payload.requestId && streamingByRequestId[payload.requestId] && payload.message.role === 'assistant') {
    finalizeStreamingMessage(payload.requestId, payload.message);
  } else {
    appendMessage(payload.message);
  }
  if (payload.requestId && streamingByRequestId[payload.requestId] && payload.message.role !== 'assistant') {
    removeStreamingMessage(payload.requestId);
  }
  if (payload.requestId && payload.requestId === activeRequestId && payload.message.role === 'assistant') {
    shiftCompletedRequest(payload.requestId);
  }
});

socket.on('chat-progress', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId || !payload.requestId) {
    return;
  }
  if (payload.requestId === activeRequestId) {
    setAiStatus('responding', 'AI状態: 回答中...');
  }
  appendStreamingChunk(payload.requestId, payload.data || '');
});

socket.on('chat-stderr', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId || !payload.requestId) {
    return;
  }
  if (payload.requestId === activeRequestId) {
    setAiStatus('responding', 'AI状態: 回答中...');
  }
  appendStreamingChunk(payload.requestId, payload.data || '');
});

socket.on('chat-request-completed', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId || payload.requestId !== activeRequestId) {
    return;
  }
  removeStreamingMessage(payload.requestId);
  shiftCompletedRequest(payload.requestId);
});

socket.on('chat-message-failed', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId) {
    return;
  }
  if (payload.requestId) {
    removeStreamingMessage(payload.requestId);
  }
  appendMessage({
    messageId: `error-${payload.requestId || Date.now()}`,
    role: 'assistant',
    content: `エラー: ${payload.error || 'unknown error'}`,
    createdAt: new Date().toISOString()
  });
  if (!payload.requestId || payload.requestId === activeRequestId) {
    shiftCompletedRequest(payload.requestId);
    setAiStatus('error', 'AI状態: エラー');
  }
});

socket.on('chat-process-exited', (payload) => {
  if (!payload || payload.sessionId !== activeSessionId) {
    return;
  }
  appendMessage({
    messageId: `process-exited-${Date.now()}`,
    role: 'assistant',
    content: 'Copilot プロセスが終了しました。セッションを作り直してください。',
    createdAt: new Date().toISOString()
  });
  activeRequestId = null;
  activeRequestStartedAt = null;
  pendingRequestIds.length = 0;
  disableMessageInput();
  setAiStatus('error', 'AI状態: プロセス終了');
  stopSessionSyncPolling();
});

upDirBtn.addEventListener('click', () => {
  if (parentRelativePath === null) return;
  loadDirectories(parentRelativePath);
});

reloadDirBtn.addEventListener('click', () => {
  loadDirectories(currentRelativePath);
});

reloadViewerBtn.addEventListener('click', () => {
  if (!viewerRootRelativePath) {
    return;
  }
  viewerEntriesByDir.clear();
  viewerOpenDirs.clear();
  viewerOpenDirs.add('');
  loadDirectoryEntries('');
});

startSessionBtn.addEventListener('click', () => {
  if (!selectedRelativePath) {
    alert('フォルダを選択してください');
    return;
  }

  startSessionBtn.disabled = true;
  fetch('/api/chat-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workingDirectory: selectedRelativePath })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.error) {
        throw new Error(data.error);
      }
      activeSessionId = data.sessionId;
      activeRequestId = null;
      activeRequestStartedAt = null;
      pendingRequestIds.length = 0;
      renderedMessageIds.clear();
      Object.keys(streamingByRequestId).forEach((requestId) => removeStreamingMessage(requestId));
      chatMessages.innerHTML = '<div class="empty-state">メッセージを送信してください。</div>';
      chatMeta.textContent = `Session: ${activeSessionId.slice(0, 8)}... / 作業フォルダ: ~/${data.workingDirectoryRelativePath || ''}`;
      updateViewerRoot(data.workingDirectoryRelativePath || '');
      enableMessageInput();
      setAiStatus('idle', 'AI状態: 待機中');
      stopSessionSyncPolling();
      messageInput.focus();
    })
    .catch((error) => {
      alert(`セッション開始に失敗しました: ${error.message}`);
    })
    .finally(() => {
      startSessionBtn.disabled = false;
    });
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    sendMessage();
  }
});

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !activeSessionId) {
    return;
  }

  messageInput.value = '';
  setAiStatus('responding', 'AI状態: キュー投入中...');

  fetch(`/api/chat-sessions/${activeSessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.error) {
        throw new Error(data.error);
      }
      pendingRequestIds.push(data.requestId);
      if (!activeRequestId) {
        activeRequestId = data.requestId;
        activeRequestStartedAt = Date.now();
      }
      setAiStatus('responding', `AI状態: 回答中...（待ち ${pendingRequestIds.length} 件）`);
      startSessionSyncPolling();
    })
    .catch((error) => {
      alert(`送信に失敗しました: ${error.message}`);
      messageInput.value = text;
      setAiStatus('error', 'AI状態: 送信失敗');
    });
}

function fetchQueueStatus() {
  fetch('/api/status')
    .then((res) => res.json())
    .then((status) => updateQueueStatus(status))
    .catch((error) => console.error('Queue status fetch failed:', error));
}

function updateQueueStatus(status) {
  queueCountSpan.textContent = `キュー: ${status.queued}`;
  runningCountSpan.textContent = `実行中: ${status.running}`;
}

function loadDirectories(relativePath) {
  const query = encodeURIComponent(relativePath || '');
  fetch(`/api/directories?path=${query}`)
    .then((res) => res.json())
    .then((data) => {
      if (data.error) {
        throw new Error(data.error);
      }
      currentRelativePath = data.currentRelativePath || '';
      parentRelativePath = data.parentRelativePath;
      currentPathLabel.textContent = `~/${currentRelativePath}`;
      renderDirectoryList(data.directories || []);
    })
    .catch((error) => {
      alert(`フォルダ一覧の取得に失敗しました: ${error.message}`);
    });
}

function renderDirectoryList(directories) {
  if (!directories.length) {
    directoryList.innerHTML = '<div class="empty-state">サブフォルダがありません。</div>';
    return;
  }

  directoryList.innerHTML = directories
    .map((directory) => {
      const isSelected = selectedRelativePath === directory.relativePath;
      return `
        <button class="directory-item ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(directory.relativePath)}">
          <span>📁 ${escapeHtml(directory.name)}</span>
          <span class="path">~/${escapeHtml(directory.relativePath)}</span>
        </button>
      `;
    })
    .join('');

  const directoryButtons = directoryList.querySelectorAll('.directory-item');
  directoryButtons.forEach((button) => {
    const pathValue = button.getAttribute('data-path');
    button.addEventListener('click', () => {
      selectedRelativePath = pathValue;
      selectedFolderLabel.textContent = `~/${selectedRelativePath}`;
      updateViewerRoot(selectedRelativePath);
      renderDirectoryList(directories);
    });
    button.addEventListener('dblclick', () => {
      loadDirectories(pathValue);
    });
  });
}

function appendMessage(message) {
  if (!message.messageId || renderedMessageIds.has(message.messageId)) {
    return;
  }
  renderedMessageIds.add(message.messageId);
  if (chatMessages.querySelector('.empty-state')) {
    chatMessages.innerHTML = '';
  }

  const roleClass = message.role === 'assistant' ? 'assistant' : 'user';
  const contentHtml = roleClass === 'assistant'
    ? renderMarkdown(message.content)
    : escapeHtml(message.content).replace(/\n/g, '<br>');
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message ${roleClass}`;
  wrapper.innerHTML = `
    <div class="meta">${roleClass === 'assistant' ? 'Copilot' : 'You'} · ${new Date(message.createdAt).toLocaleString('ja-JP')}</div>
    <div class="content">${contentHtml}</div>
  `;
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendStreamingChunk(requestId, chunk) {
  if (!streamingByRequestId[requestId]) {
    if (chatMessages.querySelector('.empty-state')) {
      chatMessages.innerHTML = '';
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message assistant streaming';
    wrapper.setAttribute('id', `stream-${requestId}`);
    wrapper.innerHTML = `
      <div class="meta">Copilot · 生成中...</div>
      <div class="content" id="stream-content-${requestId}"></div>
    `;
    chatMessages.appendChild(wrapper);
    streamingByRequestId[requestId] = true;
  }

  const contentEl = document.getElementById(`stream-content-${requestId}`);
  if (!contentEl) {
    return;
  }
  contentEl.innerHTML += escapeHtml(chunk).replace(/\n/g, '<br>');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeStreamingMessage(requestId) {
  delete streamingByRequestId[requestId];
  const element = document.getElementById(`stream-${requestId}`);
  if (element) {
    element.remove();
  }
}

function finalizeStreamingMessage(requestId, message) {
  const wrapper = document.getElementById(`stream-${requestId}`);
  const contentEl = document.getElementById(`stream-content-${requestId}`);
  if (!wrapper || !contentEl) {
    return;
  }

  wrapper.classList.remove('streaming');
  wrapper.classList.add('assistant');

  const metaEl = wrapper.querySelector('.meta');
  if (metaEl) {
    metaEl.textContent = `Copilot · ${new Date(message.createdAt).toLocaleString('ja-JP')}`;
  }
  contentEl.innerHTML = renderMarkdown(message.content);
  delete streamingByRequestId[requestId];
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function enableMessageInput() {
  sendBtn.disabled = false;
  messageInput.disabled = false;
}

function disableMessageInput() {
  sendBtn.disabled = true;
  messageInput.disabled = true;
}

function startSessionSyncPolling() {
  if (sessionSyncTimerId || !activeSessionId) {
    return;
  }
  sessionSyncTimerId = setInterval(() => {
    if (!activeSessionId) {
      stopSessionSyncPolling();
      return;
    }
    fetch(`/api/chat-sessions/${activeSessionId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.messages)) {
          return;
        }
        data.messages.forEach((message) => appendMessage(message));
        const hasAssistantAfterRequest = data.messages.some((message) => {
          if (!activeRequestId) {
            return false;
          }
          if (message.role !== 'assistant') {
            return false;
          }
          const createdAt = new Date(message.createdAt).getTime();
          return createdAt >= (activeRequestStartedAt || 0);
        });
        if (hasAssistantAfterRequest && activeRequestId) {
          removeStreamingMessage(activeRequestId);
          shiftCompletedRequest(activeRequestId);
        }
      })
      .catch(() => {
        // Ignore transient polling errors.
      });
  }, 2000);
}

function stopSessionSyncPolling() {
  if (sessionSyncTimerId) {
    clearInterval(sessionSyncTimerId);
    sessionSyncTimerId = null;
  }
}

function shiftCompletedRequest(requestId) {
  if (requestId) {
    const index = pendingRequestIds.indexOf(requestId);
    if (index >= 0) {
      pendingRequestIds.splice(index, 1);
    } else if (pendingRequestIds.length > 0) {
      pendingRequestIds.shift();
    }
  } else if (pendingRequestIds.length > 0) {
    pendingRequestIds.shift();
  }

  activeRequestId = pendingRequestIds.length > 0 ? pendingRequestIds[0] : null;
  activeRequestStartedAt = activeRequestId ? Date.now() : null;

  if (activeRequestId) {
    setAiStatus('responding', `AI状態: 回答中...（待ち ${pendingRequestIds.length} 件）`);
    startSessionSyncPolling();
  } else {
    setAiStatus('idle', 'AI状態: 待機中');
    stopSessionSyncPolling();
  }
}

function updateViewerRoot(rootRelativePath) {
  viewerRootRelativePath = rootRelativePath || '';
  viewerSelectedFile = '';
  viewerEntriesByDir.clear();
  viewerOpenDirs.clear();
  viewerOpenDirs.add('');
  viewerRootLabel.textContent = viewerRootRelativePath ? `ルート: ~/${viewerRootRelativePath}` : 'ルート: 未選択';
  filePathLabel.textContent = 'ファイル未選択';
  fileContent.innerHTML = '<div class="empty-state">左の一覧からファイルを選択してください。</div>';
  if (!viewerRootRelativePath) {
    fileTree.innerHTML = '<div class="empty-state">フォルダを選択するとファイル一覧が表示されます。</div>';
    return;
  }
  loadDirectoryEntries('');
}

function iconForFile(name, type) {
  if (type === 'dir') return '📁';
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');
  const iconMap = {
    '.md': '📝',
    '.json': '📋',
    '.js': '📜',
    '.ts': '📜',
    '.css': '🎨',
    '.html': '🌐',
    '.png': '🖼️',
    '.jpg': '🖼️',
    '.jpeg': '🖼️',
    '.svg': '🖼️'
  };
  return iconMap[ext] || '📄';
}

function renderTreeNodes(dirPath = '', depth = 0) {
  const entries = viewerEntriesByDir.get(dirPath) || [];
  return entries
    .map((node) => {
      const rowClass = node.type === 'file' && viewerSelectedFile === node.path ? 'tree-row active' : 'tree-row';
      if (node.type === 'dir') {
        const isOpen = viewerOpenDirs.has(node.path);
        const icon = isOpen ? '📂' : '📁';
        const children = isOpen ? renderTreeNodes(node.path, depth + 1) : '';
        return `
          <div class="tree-row" style="padding-left:${depth * 14 + 8}px" data-dir-path="${escapeHtml(node.path)}">
            <span>${icon}</span>
            <span class="tree-name">${escapeHtml(node.name)}</span>
          </div>
          <div class="tree-children">${children}</div>
        `;
      }
      return `
        <div class="${rowClass}" style="padding-left:${depth * 14 + 8}px" data-file-path="${escapeHtml(node.path)}">
          <span>${iconForFile(node.name, 'file')}</span>
          <span class="tree-name">${escapeHtml(node.name)}</span>
        </div>
      `;
    })
    .join('');
}

function bindFileTreeClickHandlers() {
  const dirRows = fileTree.querySelectorAll('[data-dir-path]');
  dirRows.forEach((row) => {
    const dirPath = row.getAttribute('data-dir-path');
    row.addEventListener('click', () => {
      if (dirPath === null) return;
      toggleViewerDirectory(dirPath);
    });
  });

  const rows = fileTree.querySelectorAll('[data-file-path]');
  rows.forEach((row) => {
    const filePath = row.getAttribute('data-file-path');
    row.addEventListener('click', () => {
      if (!filePath) return;
      viewerSelectedFile = filePath;
      bindFileTreeSelection();
      openViewerFile(filePath);
    });
  });
}

function bindFileTreeSelection() {
  fileTree.querySelectorAll('[data-file-path]').forEach((row) => {
    row.classList.remove('active');
    if (row.getAttribute('data-file-path') === viewerSelectedFile) {
      row.classList.add('active');
    }
  });
}

function renderViewerTree() {
  const html = renderTreeNodes('', 0);
  fileTree.innerHTML = html || '<div class="empty-state">ファイルがありません。</div>';
  bindFileTreeClickHandlers();
  bindFileTreeSelection();
}

function loadDirectoryEntries(dirPath) {
  if (!viewerRootRelativePath) return;
  if (!viewerEntriesByDir.has(dirPath)) {
    fileTree.innerHTML = '<div class="empty-state">ファイル一覧を読み込み中...</div>';
  }

  fetch(`/api/files/tree?root=${encodeURIComponent(viewerRootRelativePath)}&dir=${encodeURIComponent(dirPath)}`)
    .then((res) => res.json())
    .then((data) => {
      if (data.error) {
        throw new Error(data.error);
      }
      viewerEntriesByDir.set(dirPath, data.entries || []);
      renderViewerTree();
    })
    .catch((error) => {
      fileTree.innerHTML = `<div class="empty-state">読み込み失敗: ${escapeHtml(error.message)}</div>`;
    });
}

function toggleViewerDirectory(dirPath) {
  if (viewerOpenDirs.has(dirPath)) {
    viewerOpenDirs.delete(dirPath);
    renderViewerTree();
    return;
  }
  viewerOpenDirs.add(dirPath);
  if (viewerEntriesByDir.has(dirPath)) {
    renderViewerTree();
    return;
  }
  loadDirectoryEntries(dirPath);
}

function openViewerFile(filePath) {
  if (!viewerRootRelativePath || !filePath) {
    return;
  }
  filePathLabel.textContent = filePath;
  fileContent.innerHTML = '<div class="empty-state">読み込み中...</div>';

  fetch(`/api/files/content?root=${encodeURIComponent(viewerRootRelativePath)}&file=${encodeURIComponent(filePath)}`)
    .then(async (res) => {
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: '読み込み失敗' }));
        throw new Error(json.error || '読み込み失敗');
      }
      if (contentType.startsWith('image/')) {
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        fileContent.innerHTML = `<img src="${objectUrl}" alt="${escapeHtml(filePath)}">`;
        return;
      }
      const text = await res.text();
      if (filePath.toLowerCase().endsWith('.md')) {
        fileContent.innerHTML = renderMarkdown(text);
      } else {
        fileContent.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      }
    })
    .catch((error) => {
      fileContent.innerHTML = `<div class="empty-state">読み込み失敗: ${escapeHtml(error.message)}</div>`;
    });
}

function setAiStatus(mode, text) {
  aiStatus.classList.remove('idle', 'responding', 'error');
  aiStatus.classList.add(mode);
  aiStatusText.textContent = text;

  if (mode === 'responding') {
    if (!aiRespondingSince) {
      aiRespondingSince = Date.now();
    }
    if (!aiStatusTimerId) {
      aiStatusTimerId = setInterval(() => {
        if (!aiRespondingSince) {
          aiStatusElapsed.textContent = '';
          return;
        }
        const seconds = Math.floor((Date.now() - aiRespondingSince) / 1000);
        aiStatusElapsed.textContent = `${seconds}s`;
      }, 300);
    }
  } else {
    aiRespondingSince = null;
    aiStatusElapsed.textContent = '';
    if (aiStatusTimerId) {
      clearInterval(aiStatusTimerId);
      aiStatusTimerId = null;
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function renderMarkdown(text) {
  if (window.marked && typeof window.marked.parse === 'function') {
    return window.marked.parse(String(text || ''));
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}
