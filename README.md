# Copilot Folder Chat Server

サーバー上のホームディレクトリ配下から任意フォルダを選択し、そのフォルダを作業ディレクトリ (`cwd`) として GitHub Copilot CLI チャットを進められる Node.js + Socket.IO サーバーです。

## 主な機能

- ホームディレクトリ配下のフォルダを Web UI で選択
- 選択フォルダごとにチャットセッションを作成
- Web UI 上で会話を継続（履歴付きで各ターンをストリーミング実行）
- 応答中でも次のメッセージを先行投入できる（サーバー側で順次処理）
- リクエストキュー管理（同時実行数 1）
- 実行ログと `--share` セッションログ保存

## セットアップ

```bash
git clone https://github.com/sono8stream/copilot-prompt-server.git
cd copilot-prompt-server
npm install
npm start
```

起動後: `http://localhost:3000`

## Web UI での使い方

1. 「作業フォルダを選択」でホーム配下のフォルダを選ぶ（ダブルクリックで下階層へ移動）
2. 「このフォルダでチャット開始」を押す
3. メッセージを送信して会話を継続

## API

### フォルダ一覧

`GET /api/directories?path=<relative-path>`

- `path` はホームディレクトリからの相対パス
- ホーム外は拒否されます

### チャットセッション作成

`POST /api/chat-sessions`

```json
{
  "workingDirectory": "webapp/copilot-prompt-server"
}
```

### チャットメッセージ送信

`POST /api/chat-sessions/:sessionId/messages`

```json
{
  "message": "このプロジェクトの構成を説明して"
}
```

### チャットセッション終了

`DELETE /api/chat-sessions/:sessionId`

### 補助 API

- `GET /api/status` キュー状況
- `GET /api/tasks` タスク履歴
- `GET /api/tasks/:taskId/session` `--share` の markdown ログ

## 補足

- Copilot CLI は `copilot` コマンドで実行可能である必要があります。
- チャットはセッションごとに Copilot CLI プロセスを1本維持し、メッセージを stdin に送る方式です。
- チャット履歴はメモリ保持です（サーバー再起動で消えます）。
