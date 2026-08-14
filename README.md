# AI Benchmark Bot

AIベンチマークの順位変動と公式モデル発表を監視し、個人Discordサーバーへ日本語で通知するBotです。Node.js 24、TypeScript、discord.js、SQLiteで動作し、外部公開ポートは使いません。

## 実装済みの機能

- LMArena Overall / Codingを3時間ごと、SWE-bench Verifiedを6時間ごとに監視
- OpenAI、Anthropic、Google Gemini、Mistral、xAI、DeepSeekの公式更新元を1時間ごとに監視
- Z.aiとMoonshot AI / Kimiの公式Markdown adapterをopt-inで利用可能
- 公式発表とベンチマーク初登場を別イベントとして保存
- Top 10出入り、大幅順位変動、verified変更、定義変更、障害・復旧を即時通知
- 細かな変動を07:00（Asia/Tokyo）の日次ダイジェストへ集約
- 初回baseline、表示精度での比較、削除の2回確認、異常snapshot隔離、event/outbox一意制約
- Guild限定Slash Command、`Guilds` Intentのみ、mention無効化、再送時の決定的nonce
- SQLite WAL、migration、保持期限処理、Online Backup、systemd unit

MetaとQwenのadapterも含まれますが、既定では無効です。`npm run contracts:check-staged` をJSTの異なる7日間に1回ずつ成功させると、DB内のcontract gateが解除されます。その後 `ENABLE_META=true` / `ENABLE_QWEN=true` でBotを再起動し、対応する `/benchmark watch enable` を実行して段階的に有効化できます。7日未満では環境変数を有効にしてもadapterはfail closedで停止します。

Z.aiは公式の構造化された[Model Release Notes](https://docs.z.ai/release-notes/new-released)を、MoonshotはPlatform Changelogが最近のモデルを網羅しないため、機械可読な[Model List](https://platform.kimi.ai/docs/models)を監視します。Moonshotの通知は「発表」ではなく「公式モデル一覧への追加」と区別します。

ただし、両社の利用規約には自動取得・データ抽出・名称表示に関する広い制限があり、公開Markdownの提供だけをもって第三者Botでの定期利用が許諾済みとは判断していません。そのため両adapterとwatchは既定OFFです。現在の[Z.ai Terms](https://docs.z.ai/legal-agreement/terms-of-use)と[Kimi OpenPlatform Terms](https://platform.kimi.ai/docs/agreement/modeluse)を確認し、利用可能と判断した場合だけ `ENABLE_ZAI=true` / `ENABLE_MOONSHOT=true` を設定して再起動し、対応する `/benchmark watch enable` を実行してください。

## 必要環境

- Node.js 24.17以上（`.node-version` は24.18.1）
- Discord Bot token、Application ID、対象Guild ID
- Bot権限: `View Channel`、`Send Messages`、`Embed Links`

Message ContentやAdministrator権限は不要です。SWE-benchの条件に合わせ、このMVPは非商用・単一Guild・単一通知チャンネルを前提とします。

Discord Developer PortalでApplicationとBotを作成し、Privileged Gateway Intentsはすべて無効のままにします。OAuth2 URL Generatorでは `bot` と `applications.commands` scope、権限値 `19456`（View Channel + Send Messages + Embed Links）だけを選び、対象サーバーへ追加してください。Application ID、サーバーID、再生成したBot tokenを `.env` へ設定します。

## セットアップ

```sh
npm ci
cp .env.example .env
# .envへDISCORD_TOKEN、DISCORD_CLIENT_ID、DISCORD_GUILD_IDを設定
npm run check
npm test
npm run build
npm run commands:register
npm start
```

初回起動時にDB migrationが適用され、各取得元の最初の正常応答は通知せずbaselineとして保存されます。Bot起動後、Discordで次を実行してください。

```text
/benchmark setup channel channel:#通知先
/benchmark test
/benchmark status
```

## Slash Command

| Command | 内容 |
| --- | --- |
| `/benchmark setup channel` | 通知先を設定 |
| `/benchmark watch enable\|disable target` | 監視対象を切り替え |
| `/benchmark watch list` | 現在の監視設定を表示 |
| `/benchmark ranking leaderboard limit` | 最新順位を表示（最大25件） |
| `/benchmark changes hours` | 直近1〜168時間の履歴を表示 |
| `/benchmark digest now` | 空でない場合に現在までの要約を生成 |
| `/benchmark status` | 取得元の成功時刻、失敗数、revisionを表示 |
| `/benchmark test` | 権限確認を兼ねたテスト通知 |

設定変更、手動ダイジェスト、テスト通知は `Manage Guild` 権限保持者だけが実行できます。

## 開発・運用コマンド

```sh
npm run doctor          # 設定、DB、Nodeバージョンを確認
npm run db:migrate      # migrationを明示実行
npm run sources:check   # 全有効adapterを1回取得して契約を確認
npm run contracts:check-staged # Meta/Qwenの日次contract結果を記録
npm run db:backup       # Online Backupを作成し直近7世代を保持
npm run dev             # TypeScriptのまま開発起動
```

構造化ログは標準出力へJSONで出力します。取得失敗は指数的に再試行し、3回連続失敗で `source.degraded`、次の成功で `source.recovered` を通知します。Discord 429は `Retry-After` に従い、403/404では通知先を無効化します。

方式変更は、取得元が公開するcategory/version/schemaの変化、または反復する大規模順位異常から検出します。取得元が識別子を変えず、件数や順位にも大きく現れない方法論変更は機械的に確定できないため、この場合はadapter更新時のcontract確認が必要です。

DB内ではevent fingerprint、配送mark、Outboxの一意制約で再送を防ぎ、Discord送信には決定的nonceを使います。ただしDiscord RESTの応答後・DB確定前にホストが長時間停止すると、Discord側のnonce保持期間を越えて重複する可能性があり、外部APIをまたぐ厳密なexactly-onceは保証できません。systemdの10秒再起動と60秒のclaim回収により、通常のクラッシュではnonce期間内に復旧する設計です。

Linux VMへの配備手順は [deploy/README.md](deploy/README.md)、環境変数例は [.env.example](.env.example) を参照してください。

## データとライセンス

- LMArena: 公式Hugging Face dataset（CC BY 4.0）。投稿には公式URLを付与します。
- SWE-bench: 公式 `leaderboards.json`（CC BY-NC 4.0を前提）。商用・一般公開化の前に再利用条件を再確認してください。
- 公式発表: 記事本文は保存せず、タイトル、短い説明、URL、hashのみ保存します。

本Botは各取得元と非提携の個人向けプロジェクトです。ロゴや記事本文は転載せず、公開されている更新情報の最小限のメタデータと公式リンクだけを扱います。この制限は取得許諾を代替するものではありません。一般公開・商用化する場合は、すべての取得元の最新利用条件と必要な許諾を改めて確認してください。

Artificial Analysis、LiveBench、終了済みOpen LLM LeaderboardはMVP対象外です。

## 検証範囲

fixtureによるparser契約、差分判定、重複防止、異常snapshot、配送再試行、日次ダイジェストをVitestで検証します。実Discord Gateway、実チャンネル権限、Linux上のsystemd起動・復旧は、配備先環境で最終確認してください。
