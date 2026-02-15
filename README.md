# Copilot Bug Investigation Server

チケット番号を指定することで、GitHub Copilot CLIを使用してバグ調査を自動実行するNode.jsサーバーです。複数のリクエストをキューで管理し、リアルタイムでGUIに結果を表示します。

## 📋 機能

- **チケット番号ベースのバグ調査** - チケット番号を入力するだけで `/bug-investigation チケット番号` というプロンプトを自動生成
- **タスクキュー管理** - 複数のリクエストを順序立てて処理（デフォルト：同時実行数1）
- **リアルタイム更新** - Socket.IOを使用したリアルタイムGUI更新
- **ログ記録** - すべてのリクエストと結果を日付別ログファイルに自動保存
- **Web GUI** - 直感的なブラウザインターフェース
- **REST API** - プログラマティックなリクエスト送信に対応

## 🚀 インストール

### 前提条件
- Node.js 14以上
- npm または yarn
- GitHub Copilot CLI (`copilot`コマンド)

### セットアップ

```bash
# リポジトリをクローン
git clone https://github.com/sono8stream/copilot-prompt-server.git
cd copilot-prompt-server

# 依存パッケージをインストール
npm install

# サーバーを起動
npm start
```

サーバーが起動すると、以下が表示されます：
```
🚀 Server running on http://localhost:3000
📋 Queue system ready to process tasks
🔌 Socket.IO ready for real-time updates
```

## 💻 使用方法

### 1. Web GUI（推奨）

1. ブラウザで [http://localhost:3000](http://localhost:3000) にアクセス
2. チケット番号を入力（例: `BUG-123`）
3. 「🔍 バグ調査をリクエスト」をクリック
4. リアルタイムで処理状況と結果が表示されます

### 2. REST API

**リクエスト例（PowerShell）:**
```powershell
$body = @{ ticketNumber = "BUG-123" } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:3000/api/request-story" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

**リクエスト例（curl）:**
```bash
curl -X POST http://localhost:3000/api/request-story \
  -H "Content-Type: application/json" \
  -d '{"ticketNumber":"BUG-123"}'
```

**レスポンス例:**
```json
{
  "taskId": "1770806640111xyfauoxrq",
  "ticketNumber": "BUG-123",
  "prompt": "/bug-investigation BUG-123",
  "queueStatus": {
    "running": 0,
    "queued": 0,
    "concurrency": 1
  },
  "message": "Bug investigation task queued successfully"
}
```

### 3. キューステータス確認

```bash
curl http://localhost:3000/api/status
```

**レスポンス例:**
```json
{
  "running": 1,
  "queued": 2,
  "concurrency": 1
}
```

## 📁 ディレクトリ構成

```
claude-server/
├── README.md              # このファイル
├── package.json           # Node.js依存关系定义
├── server.js              # メインサーバーファイル
├── queue.js               # タスクキュー管理モジュール
├── logs/                  # ログファイル保存先
│   └── copilot-requests-YYYY-MM-DD.log
└── public/                # フロントエンド
    ├── index.html         # メインGUI
    ├── script.js          # クライアント側JavaScript
    └── style.css          # GUI スタイル
```

## 📝 ログ

すべてのリクエストは `logs/` ディレクトリに日付別ログファイルとして保存されます。

**ログファイル名:** `copilot-requests-YYYY-MM-DD.log`

**ログ例:**
```json
[2026-02-11T09:23:32.556Z] {"event":"api-request","endpoint":"/api/request-story","taskId":"1770801812515d4jtj0pie","ticketNumber":"BUG-123","prompt":"/bug-investigation BUG-123"}
[2026-02-11T09:23:37.338Z] {"event":"task-started","taskId":"1770801812515d4jtj0pie"}
[2026-02-11T09:24:07.152Z] {"event":"task-completed","taskId":"1770801812515d4jtj0pie","status":"completed","result":{"stdout":"...調査結果...","stderr":"...","code":0}}
```

## ⚙️ 設定

### ポート変更

```bash
PORT=8080 npm start
```

### 同時実行数変更

[server.js](server.js#L44) の以下の行を変更：

```javascript
const taskQueue = new TaskQueue(1);  // 1を変更（例：3で同時実行3つまで）
```

## 🔧 トラブルシューティング

### `copilot` コマンドが見つからない

GitHub Copilot CLIをインストール・認証してください：

```bash
npm install -g @github/copilot-cli
copilot auth login
```

### ポート3000が既に使用されている

別のポートを指定：

```bash
PORT=3001 npm start
```

### Socket.IOの接続エラー

ファイアウォール設定を確認し、ポート3000へのアクセスが許可されているか確認してください。

## 📊 キューシステム

- **同時実行数:** 1（デフォルト）
- **キュー上限:** 無制限
- **タイムアウト:** 30秒/リクエスト

複数のリクエストが来た場合、自動的にキューに追加され、順序に処理されます。

## 🔌 Socket.IOイベント

### クライアント受信

- `task-queued` - タスクがキューに追加された
- `task-started` - タスク処理が開始された  
- `task-completed` - タスク処理が完了した

### リアルタイム機能

接続中のすべてのクライアントに対して、リアルタイムで以下の情報が送信されます：

- キュー内のタスク数
- 実行中のタスク数
- 完了したタスクの結果

## 📄 ライセンス

MIT License

## 🤝 サポート

問題が発生した場合は、GitHubのIssueを作成してください。
