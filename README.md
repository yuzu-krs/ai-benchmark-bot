# AI Benchmark Bot

LMArena / Artificial Analysis のランキングを毎日1回（1Embedに最大4ボード）、主要プロバイダーの新モデル発表を即時に、個人Discordサーバーへ日本語で通知するBotです。

- **Node.js 24.18.1+** / TypeScript / discord.js（REST送信のみ・Gateway接続なし）
- 状態は `data/` 配下の小さなJSONファイルだけ（DB不要）
- スラッシュコマンド登録不要・Privileged Intents不要

## 機能

### 📊 Daily Ranking

毎日 `DIGEST_HOUR:DIGEST_MINUTE`（既定 07:00 Asia/Tokyo）に、次の5ボードそれぞれのTOP10を1つのEmbedで必ず投稿します。

`🏆 LMArena Overall` → `💻 LMArena Coding` → `🧠 AA Intelligence` → `🛠️ AA Coding`（`AA_API_KEY` 設定時）

- 変動がなくても毎日投稿し、前回との差分を `🥇🥈🥉` `⬆️ +2` `⬇️ -1` `➖` `🆕 NEW` で示します
- 各行にはOpenRouter公開APIから取得した短縮価格 `· $1.2/$12`（入力/出力のUSD・1Mトークンあたり、フッターの `💰` 凡例参照）が付きます。マッチしない行は価格なしで表示されます
- 価格取得に失敗してもランキングは必ず投稿され、価格だけが省略されます
- 1ボードだけ取得失敗しても投稿は続行し、失敗ボードは `⚠️ ランキングを取得できませんでした。` と表示します
- Discord投稿に失敗した場合は未投稿のまま残るため、次のtick（1分後）で自動再試行します

LMArenaのデータはHugging Face.datasets-server経由で公式dataset `lmarena-ai/leaderboard-dataset` から /rows で取得します（/filter はインデックス不具合で長期-downしていたため使いません）。Overallは `text_style_control` configの行データからカテゴリ `overall`（旧 `text`）を優先順にクライアント側で選択します。上流の一時的な5xx・429・タイムアウトは5秒→15秒のバックオフで3回まで自動リトライし、/rowsがロック中（501 "the dataset is currently locked"）でも `/first-rows`（キャッシュ配信・先頭100行）にフォールバックして当日分を取得します。同名モデルが複数行ある場合は最上位の行だけを採用します。

🧠 AA Intelligence と 🛠️ AA Coding はArtificial Analysisの無料枠データです。`GET https://artificialanalysis.ai/api/v2/language/models/free` をヘッダ `x-api-key`（環境変数 `AA_API_KEY`）付きで取得します。レスポンスは約4ページに分かれているため `pagination` のカーソルを追跡して全ページ（上限8ページのハードキャップ）を結合し、途中で失敗した場合はそのボードを失敗扱いにします（部分的なTOP10は投稿しません）。APIはrankを返さないためスコア降順でクライアント側に採番し、未計測（null）の行はボードごとに除外します。差分比較のキーにはAPIが返す安定ID（UUID）を使うため、表示名が変わっても比較は崩れません。無料枠は約100リクエスト/24時間のレート制限がありますが、取得は1日1回・両ボードで同じレスポンスを共有するため十分な余裕があります。利用規約により、AAボードを含む投稿には毎回フッターに `データ: artificialanalysis.ai` の出典表記を表示します（`🧠 AA指数 0-100` の目盛り注記もフッターに併記）。`AA_API_KEY` を未設定にした場合はAAボードの2つだけが警告なしで省略され、残りのボードだけで投稿します。

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
- 通知Embedには `💰 価格 / コンテキスト` フィールドが付きます。OpenRouterのカタログから対応モデルを紐付け、入力/出力価格（$/1Mトークン）とコンテキスト長（`200K` / `1M`）を表示します。無料モデルは `無料`、変動制は `変動制`、OpenRouterに載っていないモデルは表示を省略します
- 価格取得に失敗しても通知自体は必ず送られ、価格フィールドだけが省略されます
- 通知済みモデルは `seen-models.json` で管理し、重複通知しません（上限500件、古いものから削除）
- **初回起動時は現在のモデルを無通知でベースラインとして記録**するため、既存モデルが一斉通知されることはありません
- 通知送信に失敗したモデルは未記録のまま残り、次回ポーリングで再通知を試みます

価格・コンテキスト長はOpenRouterの公開モデル一覧 `https://openrouter.ai/api/v1/models`（認証不要・ページングなし）から取得し、モデルID・表示名をファジーマッチングで紐付けます。紐付けは精度優先（誤った価格を表示しない）で、不一致行は価格なしになります。

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
| `AA_API_KEY` | — | 任意。設定すると Artificial Analysis の Intelligence / Coding ボードを追加（未設定でも LMArena は従来どおり投稿） |

価格取得（OpenRouter）は公開APIのため認証情報は不要です。

## 状態保存（DB不使用）

```text
data/
├─ lmarena-overall.json     # 前回のOverall TOP10（差分比較用）
├─ lmarena-coding.json      # 前回のCoding TOP10
├─ aa-intelligence.json     # 前回のAA Intelligence TOP10（AA_API_KEY設定時）
├─ aa-coding.json           # 前回のAA Coding TOP10（AA_API_KEY設定時）
├─ seen-models.json         # 通知済みモデル（上限500件、古いものから削除）
└─ last-posted.json         # Daily Rankingの当日投稿済みフラグ（二重投稿防止・起動時catch-up）
```

書き込みはtmpファイル＋renameのatomic writeで、再起動しても状態は維持されます。破損した状態ファイルがあると起動時にエラーで停止するため、該当ファイルを修復または削除してください。価格データは永続化せず、投稿のたびに取得します。

## 処理フロー

```text
Bot起動
│
├─ 📊 Daily Ranking（60秒tickで判定）
│    毎日設定時刻以降かつ当日未投稿
│      → LMArena Overall / Coding・AA Intelligence / AA Coding（AA_API_KEY設定時）と OpenRouterカタログを並列取得（Overallはカテゴリ行が揃うまで冒頭ページ、AAは全ページ結合／カタログ取得は失敗時は価格なしで続行）
│      → data/<ボード>.json の前回ランキングと比較
│      → Embed生成・投稿 → 成功したボードだけ保存 → last-posted.json記録
│
└─ 🚀 New Model Alert（起動時 + ALERT_POLL_MINUTESごと）
     10プロバイダーを並列取得・パース・分類
       → confirmed な新モデルだけOpenRouterカタログ取得（失敗時は価格なしで続行）→ 即時通知 → seen-models.jsonへ記録
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
- Artificial Analysis: Intelligence Index / Coding Index の無料枠データ。利用規約により、AAボードを含む投稿には毎回フッターに出典（[artificialanalysis.ai](https://artificialanalysis.ai/)）を表示します。
- 公式発表: タイトル・短い要約・URLのみを扱い、記事本文は保存しません。
- OpenRouter: 公開APIのモデルメタデータ（価格・コンテキスト長）を短い引用として表示します。本BotはOpenRouterと非提携です。

本Botは各取得元と非提携の個人向けプロジェクトです。一般公開・商用化する場合は各取得元の最新の利用条件を再確認してください。

Linux VMへの配備は [deploy/README.md](deploy/README.md) を参照してください。
