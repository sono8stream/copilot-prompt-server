const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function requestJson({ port, method, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        : undefined
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        try {
          const json = raw ? JSON.parse(raw) : {};
          resolve({ statusCode: res.statusCode || 0, json });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson({
        port,
        method: 'GET',
        pathname: '/api/status'
      });
      if (response.statusCode === 200) {
        return;
      }
    } catch (_error) {
      // ignore retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Server did not start in time');
}

test('chat request returns assistant reply from streamed one-shot turn', async () => {
  const port = 3400 + Math.floor(Math.random() * 300);
  const mockCopilotPath = path.join(__dirname, 'mock-copilot.js');
  const serverPath = path.join(__dirname, '..', 'server.js');

  const serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      COPILOT_BIN: mockCopilotPath
    },
    stdio: 'pipe'
  });

  try {
    await waitForServer(port);

    const createSession = await requestJson({
      port,
      method: 'POST',
      pathname: '/api/chat-sessions',
      body: { workingDirectory: 'webapp/copilot-prompt-server' }
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = createSession.json.sessionId;
    assert.ok(sessionId);

    const sendMessage = await requestJson({
      port,
      method: 'POST',
      pathname: `/api/chat-sessions/${sessionId}/messages`,
      body: { message: 'hello' }
    });
    assert.equal(sendMessage.statusCode, 200);

    const deadline = Date.now() + 10000;
    let assistantContent = '';
    while (Date.now() < deadline) {
      const session = await requestJson({
        port,
        method: 'GET',
        pathname: `/api/chat-sessions/${sessionId}`
      });
      assert.equal(session.statusCode, 200);
      const assistantMessages = session.json.messages.filter((msg) => msg.role === 'assistant');
      if (assistantMessages.length > 0) {
        assistantContent = assistantMessages[assistantMessages.length - 1].content;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    assert.ok(assistantContent.includes('MOCK_STREAM_PART1'));
    assert.ok(assistantContent.includes('MOCK_STREAM_PART2(hello)'));
    assert.equal(assistantContent.includes('ONESHOT_SHOULD_NOT_BE_USED'), false);
  } finally {
    serverProcess.kill();
  }
});

test('chat accepts queued input while previous reply is running', async () => {
  const port = 3800 + Math.floor(Math.random() * 300);
  const mockCopilotPath = path.join(__dirname, 'mock-copilot.js');
  const serverPath = path.join(__dirname, '..', 'server.js');

  const serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      COPILOT_BIN: mockCopilotPath
    },
    stdio: 'pipe'
  });

  try {
    await waitForServer(port);

    const createSession = await requestJson({
      port,
      method: 'POST',
      pathname: '/api/chat-sessions',
      body: { workingDirectory: 'webapp/copilot-prompt-server' }
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = createSession.json.sessionId;

    const first = await requestJson({
      port,
      method: 'POST',
      pathname: `/api/chat-sessions/${sessionId}/messages`,
      body: { message: 'first' }
    });
    assert.equal(first.statusCode, 200);

    const second = await requestJson({
      port,
      method: 'POST',
      pathname: `/api/chat-sessions/${sessionId}/messages`,
      body: { message: 'second' }
    });
    assert.equal(second.statusCode, 200);

    const deadline = Date.now() + 12000;
    let assistantCount = 0;
    let joined = '';
    while (Date.now() < deadline) {
      const session = await requestJson({
        port,
        method: 'GET',
        pathname: `/api/chat-sessions/${sessionId}`
      });
      assert.equal(session.statusCode, 200);
      const assistants = session.json.messages.filter((msg) => msg.role === 'assistant');
      assistantCount = assistants.length;
      joined = assistants.map((msg) => msg.content).join('\n');
      if (assistantCount >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert.ok(assistantCount >= 2);
    assert.ok(joined.includes('MOCK_STREAM_PART2(first)'));
    assert.ok(joined.includes('MOCK_STREAM_PART2(second)'));
  } finally {
    serverProcess.kill();
  }
});
