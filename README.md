# AI Benchmark Bot

LMArena のランキングを毎日1回、主要プロバイダーの新モデル発表を即時に、個人Discordサーバーへ日本語で通知するBotです。

- **Node.js 24.18.1+** / TypeScript / discord.js（REST送信のみ・Gateway接続なし）
- 状態は `data/` 配下の小さなJSONファイルだけ（DB不要）
- スラッシュコマンド登録不要・Privileged Intents不要

## 機能

### 📊 Daily Ranking

毎日 `DIGEST_HOUR:DIGEST_MINUTE`（既定 07:00 Asia/Tokyo）に、LMArena **Overall** と **Coding** のTOP10を必ず投稿します。

- 変動がなくても毎日投稿し、前回との差分を `🥇🥈🥉` `⬆️ +2` `⬇️ -1` `➖` `🆕 NEW` で示します
- 1ボードだけ取得失敗しても投稿は続行し、失敗ボードは `⚠️ ランキングを取得できませんでした。` と表示します
- Discord投稿に失敗した場合は未投稿のまま残るため、次のtick（1分後）で自動再試行します

データはHugging Face.datasets-server経由で公式dataset `lmarena-ai/leaderboard-dataset` から /rows で取得します（/filter はインデックス不具合で長期-downしていたため使いません）。Overallは `text_style_control` configの行データからカテゴリ `overall`（旧 `text`）を優先順にクライアント側で選択します。上流の一時的な5xx・429・タイムアウトは5秒→15秒のバックオフで3回まで自動リトライし、/rowsがロック中（501 "the dataset is currently locked"）でも `/first-rows`（キャッシュ配信・先頭100行）にフォールバックして当日分を取得します。同名モデルが複数行ある場合は最上位の行だけを採用します。

### 🚀 New Model Alert

OpenAI / Anthropic / Google / xAI / Mistral / DeepSeek / Z.ai / Qwen / Moonshot / Meta の公式changelog・リリースノートを `ALERT_POLL_MINUTES`（既定60分）ごとに確認し、新しいモデルの正式発表（confidence: confirmed）を検出したら即時通知します。

| プロバイダー | 取得先 | 形式 |
| --- | --- | --- |
| OpenAI | `developers.openai.com/api/docs/changelog` | Markdown |
| Anthropic | `platform.claude.com/docs/en/release-notes/feed.xml` | RSS |
| Google | `ai.google.dev/gemini-api/docs/changelog` | HTML |
| xAI | `docs.x.ai/developers/release-notes` | Markdown |
| Mistral | `mistral.ai/news/rss` | RSS |
| DeepSeek | `api-docs.deepseek.com/updates` | HTML |
| Z.ai | `docs.z.ai/release-notes` | HTML |
| Qwen | HF `api/models?author=Qwen` | JSON |
| Moonshot AI | HF `api/models?author=moonshotai` | JSON |
| Meta (Llama) | HF `api/models?author=meta-llama` | JSON |

- Hugging Face組織ソース（Qwen / Moonshot / Meta）はFP8・GGUF等の量子化バリアントとGuard系セーフティモデルを除外します
- 通知済みモデルは `seen-models.json` で管理し、重複通知しません（上限500件、古いものから削除）
- **初回起動時は現在のモデルを無通知でベースラインとして記録**するため、既存モデルが一斉通知されることはありません
- 通知送信に失敗したモデルは未記録のまま残り、次回ポーリングで再通知を試みます

## セットアップ

```sh
npm ci
cp .env.example .env
# .env へ DISCORD_TOKEN と DISCORD_CHANNEL_ID を設定
npm run check
npm test
npm run build
npm start
```

Botの招待に必要な権限は `View Channel` / `Send Messages` / `Embed Links`（権限値 19456）だけです。

起動すると、設定時刻を過ぎている場合はその日のランキングを投稿し（catch-up）、プロバイダーの初回ベースラインを記録します。

## 環境変数

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | —（必須） | Bot token |
| `DISCORD_CHANNEL_ID` | —（必須） | 通知先テキストチャンネルID |
| `TIME_ZONE` | `Asia/Tokyo` | IANAタイムゾーン |
| `DIGEST_HOUR` / `DIGEST_MINUTE` | `7` / `0` | Daily Rankingの実行時刻 |
| `ALERT_POLL_MINUTES` | `60` | 新モデル確認間隔（5以上） |
| `DATA_DIR` | `./data` | 状態JSONの保存先 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `HUGGINGFACE_TOKEN` | — | 任意。LMArena取得のレート制限緩和 |

## 状態保存（DB不使用）

```text
data/
├─ lmarena-overall.json   # 前回のOverall TOP10（差分比較用）
├─ lmarena-coding.json    # 前回のCoding TOP10
├─ seen-models.json       # 通知済みモデル（上限500件、古いものから削除）
└─ last-posted.json       # Daily Rankingの当日投稿済みフラグ（二重投稿防止・起動時catch-up）
```

書き込みはtmpファイル＋renameのatomic writeで、再起動しても状態は維持されます。破損した状態ファイルがあると起動時にエラーで停止するため、該当ファイルを修復または削除してください。

## 処理フロー

```text
Bot起動
│
├─ 📊 Daily Ranking（60秒tickで判定）
│    毎日設定時刻以降かつ当日未投稿
│      → LMArena Overall / Coding を並列取得（Overallはカテゴリ行が揃うまで冒頭ページ、Codingは先頭ページのみ）
│      → data/lmarena-*.json の前回ランキングと比較
│      → Embed生成・投稿 → 成功したボードだけ保存 → last-posted.json記録
│
└─ 🚀 New Model Alert（起動時 + ALERT_POLL_MINUTESごと）
     6プロバイダーを並列取得・パース・分類
       → confirmed な新モデルだけ即時通知 → seen-models.jsonへ記録
```

HTTP 500・timeout等の取得失敗はログに記録され、他ボード・他プロバイダーの処理は続行します。ログは標準出力へJSONで出力されます。

## 開発

```sh
npm run dev   # ビルドせず tsx で起動
npm test      # Vitest
npm run check # 型チェック
```

## データとライセンス

- LMArena: 公式Hugging Face dataset（CC BY 4.0前提）。投稿には公式URLを添えます。
- 公式発表: タイトル・短い要約・URLのみを扱い、記事本文は保存しません。

本Botは各取得元と非提携の個人向けプロジェクトです。一般公開・商用化する場合は各取得元の最新の利用条件を再確認してください。

Linux VMへの配備は [deploy/README.md](deploy/README.md) を参照してください。
