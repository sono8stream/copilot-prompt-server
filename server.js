const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const TaskQueue = require('./queue');

// Setup logs directory
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log file path
const logFilePath = path.join(logsDir, `copilot-requests-${new Date().toISOString().split('T')[0]}.log`);

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*" }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Utility function to write logs
function writeLog(logEntry) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${JSON.stringify(logEntry)}\n`;

  fs.appendFile(logFilePath, logMessage, (err) => {
    if (err) {
      console.error('Failed to write log:', err);
    }
  });
}

// Task Queue with concurrency of 1
const taskQueue = new TaskQueue(1);

const tasks = [];
const maxTaskHistory = 200;

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

// Handle socket connections
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('request-story', (data) => {
    const prompt = data?.prompt || '面白い話して';
    console.log('Story request received:', prompt);

    // Create a task to run copilot command
    const taskId = taskQueue.enqueue(async () => {
      return new Promise((resolve, reject) => {
        const process = spawn('copilot', ['-p', prompt], {
          shell: true,
          windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        let completed = false;

        const timeout = setTimeout(() => {
          if (!completed) {
            process.kill();
            reject(new Error('Process timeout after 30 seconds'));
          }
        }, 5 * 60 * 1000);

        process.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        process.on('close', (code) => {
          clearTimeout(timeout);
          completed = true;
          if (code === 0) {
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              code: code
            });
          } else {
            reject(new Error(`Process exited with code ${code}: ${stderr}`));
          }
        });

        process.on('error', (err) => {
          clearTimeout(timeout);
          completed = true;
          reject(err);
        });
      });
    });

    const snapshot = {
      taskId: taskId,
      prompt: prompt,
      status: 'queued',
      createdAt: new Date().toISOString(),
      result: null,
      completedAt: null
    };
    addTaskSnapshot(snapshot);

    // Notify clients about the new task
    io.emit('task-queued', {
      taskId: taskId,
      prompt: prompt,
      status: 'queued',
      createdAt: snapshot.createdAt,
      queueStatus: taskQueue.getStatus()
    });

    // Log task queued
    writeLog({
      event: 'task-queued',
      taskId: taskId,
      prompt: prompt
    });
  });
});

// Task completion handler
taskQueue.onTaskComplete = (task) => {
  const response = {
    taskId: task.id,
    status: task.status,
    result: task.result,
    completedAt: new Date().toISOString(),
    queueStatus: taskQueue.getStatus()
  };

  updateTaskSnapshot(task.id, {
    status: task.status,
    result: task.result,
    completedAt: response.completedAt
  });

  console.log('Task completed:', task.id);
  io.emit('task-completed', response);

  // Log task completion
  writeLog({
    event: 'task-completed',
    taskId: task.id,
    status: task.status,
    result: task.result
  });
};

// Task start handler
taskQueue.onTaskStart = (task) => {
  console.log('Task started:', task.id);
  updateTaskSnapshot(task.id, {
    status: 'running'
  });
  io.emit('task-started', {
    taskId: task.id,
    status: 'running',
    queueStatus: taskQueue.getStatus()
  });

  writeLog({
    event: 'task-started',
    taskId: task.id
  });
};

// API endpoint to request a story
app.post('/api/request-story', (req, res) => {
  const prompt = req.body?.prompt || '面白い話して';
  console.log('📥 API Request received:', prompt);

  const taskId = taskQueue.enqueue(async () => {
    console.log('🚀 Task started executing:', taskId);
    return new Promise((resolve, reject) => {
      const process = spawn('copilot', ['-p', prompt], {
        shell: true,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let completed = false;

      const timeout = setTimeout(() => {
        if (!completed) {
          process.kill();
          reject(new Error('Process timeout after 30 seconds'));
        }
      }, 30000);

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        clearTimeout(timeout);
        completed = true;
        if (code === 0) {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code
          });
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      process.on('error', (err) => {
        clearTimeout(timeout);
        completed = true;
        reject(err);
      });
    });
  });

  const snapshot = {
    taskId: taskId,
    prompt: prompt,
    status: 'queued',
    createdAt: new Date().toISOString(),
    result: null,
    completedAt: null
  };
  addTaskSnapshot(snapshot);

  // Notify all connected clients about the new task
  console.log('📢 Broadcasting task-queued event to', io.engine.clientsCount, 'clients');
  io.emit('task-queued', {
    taskId: taskId,
    prompt: prompt,
    status: 'queued',
    createdAt: snapshot.createdAt,
    queueStatus: taskQueue.getStatus()
  });

  // Log API request
  writeLog({
    event: 'api-request',
    endpoint: '/api/request-story',
    taskId: taskId,
    prompt: prompt
  });

  res.json({
    taskId: taskId,
    queueStatus: taskQueue.getStatus(),
    message: 'Task queued successfully'
  });
});

// API endpoint to get queue status
app.get('/api/status', (req, res) => {
  res.json(taskQueue.getStatus());
});

app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: tasks,
    queueStatus: taskQueue.getStatus()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Queue system ready to process tasks`);
  console.log(`🔌 Socket.IO ready for real-time updates\n`);
});
