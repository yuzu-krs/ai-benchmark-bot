# Linux VM 配備手順

systemdで1ユニット運用します。SQLite・migration・backup timerはもう存在しません。

## セットアップ

```sh
sudo useradd --system --home /var/lib/ai-benchmark-bot --shell /usr/sbin/nologin ai-benchmark-bot
sudo mkdir -p /opt/ai-benchmark-bot /var/lib/ai-benchmark-bot
# リポジトリをビルドして dist/ と node_modules/ と package.json を /opt/ai-benchmark-bot へ配置
sudo cp deploy/systemd/ai-benchmark-bot.service /etc/systemd/system/
sudo cp deploy/ai-benchmark-bot.env.example /etc/ai-benchmark-bot.env
sudo chmod 600 /etc/ai-benchmark-bot.env
# /etc/ai-benchmark-bot.env に DISCORD_TOKEN / DISCORD_CHANNEL_ID を設定（HUGGINGFACE_TOKEN / AA_API_KEY は任意。AA_API_KEY を設定すると AA Intelligence / AA Coding ボードも投稿対象になる）
sudo systemctl daemon-reload
sudo systemctl enable --now ai-benchmark-bot
```

状態ファイルは `EnvironmentFile` の `DATA_DIR`（既定 `/var/lib/ai-benchmark-bot/data`）へ保存されます。

## 運用

```sh
journalctl -u ai-benchmark-bot -f          # ログ追跡
sudo systemctl restart ai-benchmark-bot    # 再起動（状態はdata/に保持される）
```

バックアップが必要な場合は `data/` ディレクトリをコピーしてください（数KBのJSONのみ）。
