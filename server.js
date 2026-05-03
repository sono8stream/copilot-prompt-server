const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const TaskQueue = require('./queue');

const homeDirectory = os.homedir();
const copilotCommand = process.env.COPILOT_BIN || 'copilot';

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const sessionsDir = path.join(logsDir, 'sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const logFilePath = path.join(logsDir, `copilot-requests-${new Date().toISOString().split('T')[0]}.log`);

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.get('/vendor/marked.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
});

function writeLog(logEntry) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${JSON.stringify(logEntry)}\n`;
  fs.appendFile(logFilePath, logMessage, (err) => {
    if (err) {
      console.error('Failed to write log:', err);
    }
  });
}

function generateId() {
  return Date.now() + Math.random().toString(36).slice(2, 11);
}

function normalizeRelativePath(relativePathInput) {
  const relativePath = typeof relativePathInput === 'string'
    ? relativePathInput.trim().replace(/\\/g, '/')
    : '';
  return relativePath === '.' ? '' : relativePath;
}

function resolveHomeDirectory(relativePathInput) {
  const normalizedRelativePath = normalizeRelativePath(relativePathInput);
  const absolutePath = path.resolve(homeDirectory, normalizedRelativePath || '.');
  const relativeFromHome = path.relative(homeDirectory, absolutePath);

  if (relativeFromHome.startsWith('..') || path.isAbsolute(relativeFromHome)) {
    throw new Error('ホームディレクトリ外のパスは指定できません');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error('指定されたフォルダが存在しません');
  }
  if (!fs.statSync(absolutePath).isDirectory()) {
    throw new Error('指定されたパスはフォルダではありません');
  }

  return {
    absolutePath: absolutePath,
    relativePath: relativeFromHome === '' ? '' : relativeFromHome.replace(/\\/g, '/')
  };
}

function listDirectories(relativePathInput) {
  const { absolutePath, relativePath } = resolveHomeDirectory(relativePathInput);
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      return {
        name: entry.name,
        relativePath: childRelativePath
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentRelativePath = relativePath
    ? path.posix.dirname(relativePath) === '.'
      ? ''
      : path.posix.dirname(relativePath)
    : null;

  return {
    homeDirectory: homeDirectory,
    absolutePath: absolutePath,
    relativePath: relativePath,
    parentRelativePath: parentRelativePath,
    directories: directories
  };
}

const FILE_MIME_TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp']);

function buildFileTree(absPath, rootAbsPath) {
  const stat = fs.statSync(absPath);
  const relativeFromRoot = path.relative(rootAbsPath, absPath).replace(/\\/g, '/');
  const nodePath = relativeFromRoot === '' ? '' : relativeFromRoot;
  const name = nodePath ? path.basename(absPath) : path.basename(rootAbsPath);

  if (stat.isFile()) {
    return { type: 'file', name, path: nodePath };
  }

  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const children = entries
    .filter((entry) => {
      if (entry.name === '.github') return true;
      if (entry.name.startsWith('.')) return false;
      if (entry.name === 'node_modules') return false;
      if (entry.name === '.DS_Store') return false;
      return true;
    })
    .map((entry) => buildFileTree(path.join(absPath, entry.name), rootAbsPath))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { type: 'dir', name, path: nodePath, children };
}

function stripAnsi(input) {
  return String(input || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-_]/g, '');
}

function sanitizeAssistantOutput(rawOutput, userInput) {
  const normalized = stripAnsi(rawOutput).replace(/\r/g, '');
  const inputTrimmed = String(userInput || '').trim();
  const lines = normalized.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    if (trimmed === inputTrimmed) {
      return false;
    }
    if (/^(Changes|Requests|Tokens|Session expires|Session exported to:|API time spent|Total session time|Total usage est)/.test(trimmed)) {
      return false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

const taskQueue = new TaskQueue(1);
const tasks = [];
const maxTaskHistory = 200;
const taskContexts = new Map();
const chatSessions = new Map();

function addTaskSnapshot(task) {
  tasks.unshift(task);
  if (tasks.length > maxTaskHistory) {
    tasks.length = maxTaskHistory;
  }
}

function updateTaskSnapshot(taskId, updates) {
  const task = tasks.find((item) => item.taskId === taskId);
  if (task) {
    Object.assign(task, updates);
  }
}

function runOneShotCopilot({ taskId, prompt, workingDirectory, onStdout, onStderr }) {
  return new Promise((resolve, reject) => {
    const sessionFile = path.join(sessionsDir, `${taskId}.md`);
    const process = spawn(copilotCommand, [
      '-p', prompt,
      '--stream', 'on',
      '--no-color',
      '--allow-all-tools',
      '--share', sessionFile
    ], {
      windowsHide: true,
      cwd: workingDirectory
    });

    let stdout = '';
    let stderr = '';
    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed) {
        process.kill();
        reject(new Error('Process timeout after 5 minutes'));
      }
    }, 5 * 60 * 1000);

    process.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onStdout) {
        onStdout(chunk);
      }
    });

    process.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (onStderr) {
        onStderr(chunk);
      }
    });

    process.on('close', (code) => {
      clearTimeout(timeout);
      completed = true;
      if (code === 0) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          sessionFile: fs.existsSync(sessionFile) ? sessionFile : null,
          code: code
        });
      } else {
        reject(new Error(`Process exited with code ${code}: ${stderr || stdout}`));
      }
    });

    process.on('error', (err) => {
      clearTimeout(timeout);
      completed = true;
      reject(err);
    });
  });
}

function enqueueCopilotTask({ prompt, taskType, workingDirectory, sessionId = null }) {
  let taskId = '';
  taskId = taskQueue.enqueue(async () => {
    return runOneShotCopilot({
      taskId: taskId,
      prompt: prompt,
      workingDirectory: workingDirectory,
      onStdout: (chunk) => io.emit('task-progress', { taskId, type: 'stdout', data: chunk }),
      onStderr: (chunk) => io.emit('task-progress', { taskId, type: 'stderr', data: chunk })
    });
  });

  taskContexts.set(taskId, {
    taskType: taskType,
    sessionId: sessionId,
    prompt: prompt,
    workingDirectory: workingDirectory
  });

  const snapshot = {
    taskId: taskId,
    prompt: prompt,
    taskType: taskType,
    sessionId: sessionId,
    workingDirectory: workingDirectory,
    status: 'queued',
    createdAt: new Date().toISOString(),
    result: null,
    completedAt: null
  };
  addTaskSnapshot(snapshot);

  io.emit('task-queued', {
    taskId: taskId,
    prompt: prompt,
    taskType: taskType,
    sessionId: sessionId,
    status: 'queued',
    createdAt: snapshot.createdAt,
    queueStatus: taskQueue.getStatus()
  });

  return taskId;
}

function serializeChatSession(session) {
  return {
    sessionId: session.sessionId,
    workingDirectoryRelativePath: session.workingDirectoryRelativePath,
    workingDirectoryAbsolutePath: session.workingDirectoryAbsolutePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    messages: session.messages,
    pendingCount: (session.pendingRequest ? 1 : 0) + (session.requestQueue ? session.requestQueue.length : 0)
  };
}

function clearPendingTimers(session) {
  if (!session.pendingRequest) {
    return;
  }
  if (session.pendingRequest.finalizeTimer) {
    clearTimeout(session.pendingRequest.finalizeTimer);
    session.pendingRequest.finalizeTimer = null;
  }
  if (session.pendingRequest.timeoutTimer) {
    clearTimeout(session.pendingRequest.timeoutTimer);
    session.pendingRequest.timeoutTimer = null;
  }
}

function processNextQueuedRequest(session) {
  if (session.pendingRequest || !session.requestQueue || session.requestQueue.length === 0) {
    return;
  }

  const nextRequest = session.requestQueue.shift();
  session.pendingRequest = {
    requestId: nextRequest.requestId,
    output: '',
    userInput: nextRequest.userInput,
    finalizeTimer: null,
    timeoutTimer: setTimeout(() => {
      completePendingRequest(session, {
        failed: true,
        error: 'AI応答がタイムアウトしました。再送してください。'
      });
    }, 30 * 1000)
  };

  io.emit('chat-request-started', {
    sessionId: session.sessionId,
    requestId: nextRequest.requestId
  });

  runChatTurn(session, nextRequest.requestId, nextRequest.prompt);
}

function completePendingRequest(session, { failed = false, error = '' } = {}) {
  if (!session.pendingRequest) {
    return;
  }
  const pending = session.pendingRequest;
  clearPendingTimers(session);
  session.pendingRequest = null;

  if (failed) {
    io.emit('chat-message-failed', {
      sessionId: session.sessionId,
      requestId: pending.requestId,
      error: error || 'Copilot process failed'
    });
    processNextQueuedRequest(session);
    return;
  }

  const content = sanitizeAssistantOutput(pending.output, pending.userInput);
  if (!content) {
    io.emit('chat-message-failed', {
      sessionId: session.sessionId,
      requestId: pending.requestId,
      error: 'AIの応答が空でした。再送してください。'
    });
    processNextQueuedRequest(session);
    return;
  }

  const assistantMessage = {
    messageId: generateId(),
    role: 'assistant',
    content: content,
    createdAt: new Date().toISOString()
  };
  session.messages.push(assistantMessage);
  session.updatedAt = assistantMessage.createdAt;

  io.emit('chat-message', {
    sessionId: session.sessionId,
    requestId: pending.requestId,
    message: assistantMessage
  });

  processNextQueuedRequest(session);
}

function schedulePendingFinalize(session) {
  if (!session.pendingRequest) {
    return;
  }
  if (session.pendingRequest.finalizeTimer) {
    clearTimeout(session.pendingRequest.finalizeTimer);
  }
  session.pendingRequest.finalizeTimer = setTimeout(() => {
    completePendingRequest(session);
  }, 1200);
}

function runChatTurn(session, requestId, prompt) {
  const chatTaskId = `${requestId}-chat`;
  const copilotArgs = [
    '-p', prompt,
    '--stream', 'on',
    '--no-color',
    '--allow-all-tools'
  ];

  if (session.hasCopilotConversation) {
    copilotArgs.push('--resume', session.copilotSessionRef);
  } else {
    copilotArgs.push('--name', session.copilotSessionRef);
  }

  const process = spawn(copilotCommand, copilotArgs, {
    windowsHide: true,
    cwd: session.workingDirectoryAbsolutePath
  });

  let completed = false;
  const timeout = setTimeout(() => {
    if (!completed) {
      process.kill();
      completePendingRequest(session, { failed: true, error: 'Process timeout after 5 minutes' });
    }
  }, 5 * 60 * 1000);

  process.stdout.on('data', (data) => {
    const chunk = data.toString();
    io.emit('chat-progress', {
      sessionId: session.sessionId,
      requestId: requestId,
      data: chunk
    });
    if (session.pendingRequest && session.pendingRequest.requestId === requestId) {
      session.pendingRequest.output += chunk;
      schedulePendingFinalize(session);
    }
  });

  process.stderr.on('data', (data) => {
    const chunk = data.toString();
    io.emit('chat-stderr', {
      sessionId: session.sessionId,
      requestId: requestId,
      data: chunk
    });
    if (session.pendingRequest && session.pendingRequest.requestId === requestId) {
      session.pendingRequest.output += chunk;
      schedulePendingFinalize(session);
    }
  });

  process.on('close', (code) => {
    completed = true;
    clearTimeout(timeout);
    if (code === 0) {
      session.hasCopilotConversation = true;
      return;
    }
    completePendingRequest(session, { failed: true, error: `Process exited with code ${code}` });
  });

  process.on('error', (error) => {
    completed = true;
    clearTimeout(timeout);
    completePendingRequest(session, { failed: true, error: error.message });
  });

  writeLog({
    event: 'chat-turn-started',
    taskId: chatTaskId,
    sessionId: session.sessionId,
    requestId: requestId,
    mode: session.hasCopilotConversation ? 'resume' : 'name'
  });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('request-story', (data) => {
    const prompt = data?.prompt || '面白い話して';
    enqueueCopilotTask({
      prompt: prompt,
      taskType: 'story',
      workingDirectory: __dirname
    });
  });
});

taskQueue.onTaskComplete = (task) => {
  const context = taskContexts.get(task.id) || {};
  const hasSession = task.result?.sessionFile
    ? fs.existsSync(task.result.sessionFile)
    : false;
  const response = {
    taskId: task.id,
    status: task.status,
    result: task.result,
    taskType: context.taskType || 'story',
    sessionId: context.sessionId || null,
    completedAt: new Date().toISOString(),
    hasSession: hasSession,
    queueStatus: taskQueue.getStatus()
  };

  updateTaskSnapshot(task.id, {
    status: task.status,
    result: task.result,
    completedAt: response.completedAt,
    hasSession: hasSession
  });
  io.emit('task-completed', response);
  taskContexts.delete(task.id);
};

taskQueue.onTaskStart = (task) => {
  const context = taskContexts.get(task.id) || {};
  updateTaskSnapshot(task.id, { status: 'running' });
  io.emit('task-started', {
    taskId: task.id,
    taskType: context.taskType || 'story',
    sessionId: context.sessionId || null,
    status: 'running',
    queueStatus: taskQueue.getStatus()
  });
};

app.get('/api/directories', (req, res) => {
  try {
    const currentPath = typeof req.query.path === 'string' ? req.query.path : '';
    const result = listDirectories(currentPath);
    res.json({
      homeDirectory: result.homeDirectory,
      currentRelativePath: result.relativePath,
      currentAbsolutePath: result.absolutePath,
      parentRelativePath: result.parentRelativePath,
      directories: result.directories
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/files/tree', (req, res) => {
  try {
    const rootRelative = typeof req.query.root === 'string' ? req.query.root : '';
    const dirRelative = typeof req.query.dir === 'string' ? req.query.dir : '';
    if (!rootRelative) {
      return res.status(400).json({ error: 'root is required' });
    }
    const { absolutePath: rootAbsolutePath } = resolveHomeDirectory(rootRelative);
    const targetAbsolutePath = path.resolve(rootAbsolutePath, dirRelative || '.');
    const relativeFromRoot = path.relative(rootAbsolutePath, targetAbsolutePath);
    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
      return res.status(403).json({ error: 'Forbidden path' });
    }
    if (!fs.existsSync(targetAbsolutePath) || !fs.statSync(targetAbsolutePath).isDirectory()) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const entries = fs.readdirSync(targetAbsolutePath, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name === '.github') return true;
        if (entry.name.startsWith('.')) return false;
        if (entry.name === 'node_modules') return false;
        if (entry.name === '.DS_Store') return false;
        return true;
      })
      .map((entry) => {
        const entryPath = path.posix.join(dirRelative, entry.name).replace(/^\/+/, '');
        return {
          type: entry.isDirectory() ? 'dir' : 'file',
          name: entry.name,
          path: entryPath
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return res.json({
      root: rootRelative,
      dir: dirRelative,
      entries: entries
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/files/content', (req, res) => {
  try {
    const rootRelative = typeof req.query.root === 'string' ? req.query.root : '';
    const fileRelative = typeof req.query.file === 'string' ? req.query.file : '';
    if (!rootRelative || !fileRelative) {
      return res.status(400).json({ error: 'root and file are required' });
    }

    const { absolutePath: rootAbsolutePath } = resolveHomeDirectory(rootRelative);
    const targetAbsolutePath = path.resolve(rootAbsolutePath, fileRelative);
    const relativeFromRoot = path.relative(rootAbsolutePath, targetAbsolutePath);
    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
      return res.status(403).json({ error: 'Forbidden path' });
    }
    if (!fs.existsSync(targetAbsolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const stat = fs.statSync(targetAbsolutePath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Path is not a file' });
    }
    if (stat.size > 1024 * 1024 * 2) {
      return res.status(413).json({ error: 'File too large (max 2MB)' });
    }

    const ext = path.extname(targetAbsolutePath).toLowerCase();
    const contentType = FILE_MIME_TYPES[ext] || 'text/plain; charset=utf-8';

    if (IMAGE_EXTENSIONS.has(ext)) {
      const buffer = fs.readFileSync(targetAbsolutePath);
      res.setHeader('Content-Type', contentType);
      return res.send(buffer);
    }

    const content = fs.readFileSync(targetAbsolutePath, 'utf-8');
    res.setHeader('Content-Type', contentType);
    return res.send(content);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/chat-sessions', (req, res) => {
  try {
    const requestedPath = req.body?.workingDirectory || '';
    const { absolutePath, relativePath } = resolveHomeDirectory(requestedPath);
    const session = {
      sessionId: generateId(),
      workingDirectoryRelativePath: relativePath,
      workingDirectoryAbsolutePath: absolutePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'ready',
      messages: [],
      pendingRequest: null,
      requestQueue: [],
      copilotSessionRef: `webui-${generateId()}`,
      hasCopilotConversation: false
    };
    chatSessions.set(session.sessionId, session);

    writeLog({
      event: 'chat-session-created',
      sessionId: session.sessionId,
      workingDirectoryRelativePath: session.workingDirectoryRelativePath,
      workingDirectoryAbsolutePath: session.workingDirectoryAbsolutePath
    });

    res.json(serializeChatSession(session));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/chat-sessions/:sessionId', (req, res) => {
  const session = chatSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Chat session not found' });
  }
  res.json(serializeChatSession(session));
});

app.delete('/api/chat-sessions/:sessionId', (req, res) => {
  const session = chatSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Chat session not found' });
  }
  clearPendingTimers(session);
  session.requestQueue = [];
  chatSessions.delete(req.params.sessionId);
  res.json({ message: 'Chat session closed' });
});

app.post('/api/chat-sessions/:sessionId/messages', (req, res) => {
  const session = chatSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Chat session not found' });
  }
  const messageText = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!messageText) {
    return res.status(400).json({ error: 'message is required' });
  }

  const userMessage = {
    messageId: generateId(),
    role: 'user',
    content: messageText,
    createdAt: new Date().toISOString()
  };
  const requestId = generateId();

  session.messages.push(userMessage);
  session.updatedAt = userMessage.createdAt;
  io.emit('chat-message', {
    sessionId: session.sessionId,
    requestId: requestId,
    message: userMessage
  });

  session.requestQueue.push({
    requestId: requestId,
    userInput: messageText,
    prompt: messageText
  });
  processNextQueuedRequest(session);

  writeLog({
    event: 'chat-message-sent',
    sessionId: session.sessionId,
    requestId: requestId,
    messageId: userMessage.messageId,
    workingDirectory: session.workingDirectoryAbsolutePath
  });

  res.json({
    sessionId: session.sessionId,
    requestId: requestId,
    message: userMessage,
    queueLength: session.requestQueue.length + (session.pendingRequest ? 1 : 0)
  });
});

app.post('/api/request-story', (req, res) => {
  const prompt = req.body?.prompt || '面白い話して';
  const taskId = enqueueCopilotTask({
    prompt: prompt,
    taskType: 'story',
    workingDirectory: __dirname
  });
  res.json({
    taskId: taskId,
    queueStatus: taskQueue.getStatus(),
    message: 'Task queued successfully'
  });
});

app.get('/api/status', (req, res) => {
  res.json(taskQueue.getStatus());
});

app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: tasks,
    queueStatus: taskQueue.getStatus()
  });
});

app.get('/api/tasks/:taskId/session', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.taskId}.md`);
  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'Session log not found' });
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.sendFile(sessionFile);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log('📋 Queue system ready to process tasks');
  console.log('🔌 Socket.IO ready for real-time updates\n');
});
