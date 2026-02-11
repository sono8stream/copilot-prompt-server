// Socket.IO connection
const socket = io();

// DOM elements
const requestBtn = document.getElementById('requestBtn');
const promptInput = document.getElementById('promptInput');
const resultsList = document.getElementById('resultsList');
const queueCountSpan = document.getElementById('queueCount');
const runningCountSpan = document.getElementById('runningCount');

// Store results locally
let results = [];

// Request button click handler
requestBtn.addEventListener('click', () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    alert('プロンプトを入力してください');
    return;
  }
  
  requestBtn.disabled = true;
  promptInput.disabled = true;
  
  fetch('/api/request-story', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt })
  })
    .then(res => res.json())
    .then(data => {
      console.log('Story requested:', data);
      requestBtn.disabled = false;
      promptInput.disabled = false;
    })
    .catch(err => {
      console.error('Error requesting story:', err);
      requestBtn.disabled = false;
      promptInput.disabled = false;
      alert('リクエストに失敗しました: ' + err.message);
    });
});

// Allow Enter key to submit
prompInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    requestBtn.click();
  }
});

// Socket event handlers
socket.on('task-queued', (data) => {
  console.log('Task queued:', data);
  
  // Add new task to results
  const result = {
    taskId: data.taskId,
    prompt: data.prompt,
    createdAt: new Date(),
    status: 'queued',
    result: null,
    completedAt: null
  };
  results.unshift(result);
  
  updateQueueStatus(data.queueStatus);
  renderResults();
});

socket.on('task-started', (data) => {
  console.log('Task started:', data);
  
  // Update task status to running
  const result = results.find(r => r.taskId === data.taskId);
  if (result) {
    result.status = 'running';
  }
  
  updateQueueStatus(data.queueStatus);
  renderResults();
});

socket.on('task-completed', (data) => {
  console.log('Task completed:', data);
  
  // Find or create result
  let result = results.find(r => r.taskId === data.taskId);
  if (!result) {
    result = {
      taskId: data.taskId,
      createdAt: new Date(),
      status: 'queued'
    };
    results.unshift(result);
  }
  
  // Update result
  Object.assign(result, {
    status: data.status,
    result: data.result,
    completedAt: data.completedAt
  });
  
  updateQueueStatus(data.queueStatus);
  renderResults();
});

// Update UI functions
function updateQueueStatus(status) {
  queueCountSpan.textContent = `キュー: ${status.queued}`;
  runningCountSpan.textContent = `実行中: ${status.running}`;
}

function renderResults() {
  if (results.length === 0) {
    resultsList.innerHTML = `
      <div class="empty-state">
        <p>まだリクエストがありません...</p>
      </div>
    `;
    return;
  }

  resultsList.innerHTML = results.map(result => createResultCard(result)).join('');
}

function createResultCard(result) {
  const status = result.status || 'queued';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const isRunning = status === 'running';
  
  const createdTime = new Date(result.createdAt).toLocaleString('ja-JP');
  let completedTime = '';
  if (result.completedAt) {
    completedTime = new Date(result.completedAt).toLocaleString('ja-JP');
  }

  let content = '';
  if (isCompleted && result.result) {
    content = `
      <div class="card-content">
        ${escapeHtml(result.result.stdout || result.result)}
      </div>
    `;
  } else if (isFailed && result.result) {
    content = `
      <div class="card-content error">
        エラー: ${escapeHtml(result.result.error || result.result)}
      </div>
    `;
  } else if (isRunning) {
    content = `
      <div class="card-content">
        <div style="text-align: center; color: #667eea;">
          <span style="animation: blink 1.4s infinite;">■</span>
          <span style="animation: blink 1.4s 0.2s infinite;">■</span>
          <span style="animation: blink 1.4s 0.4s infinite;">■</span>
          処理中...
        </div>
      </div>
    `;
  }

  const statusBadgeClass = status;
  const statusText = getStatusText(status);
  const prompt = result.prompt || '（プロンプト不明）';

  return `
    <div class="result-card ${status}">
      <div class="card-header">
        <div class="card-title">タスク #${result.taskId.substring(0, 8)}</div>
        <span class="status-badge ${statusBadgeClass}">${statusText}</span>
      </div>
      <div class="card-meta">
        <span>📝 プロンプト: ${escapeHtml(prompt)}</span>
        <span>📅 作成: ${createdTime}</span>
        ${completedTime ? `<span>✅ 完了: ${completedTime}</span>` : ''}
      </div>
      ${content}
    </div>
  `;
}

function getStatusText(status) {
  const statusMap = {
    'queued': 'キュー中',
    'running': '実行中',
    'completed': '完了',
    'failed': '失敗'
  };
  return statusMap[status] || status;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Connection events
socket.on('connect', () => {
  console.log('Connected to server');
  requestBtn.disabled = false;
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  requestBtn.disabled = true;
});

// Initial render
renderResults();
