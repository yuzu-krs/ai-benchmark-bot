# Linux VM deployment

This service opens no inbound port. It needs outbound HTTPS access to Discord and the monitored official sources.

## Install

Build the project with Node.js 24.17 or newer, then copy the application (including `dist`, `package.json`, and production dependencies) to `/opt/ai-benchmark-bot`. Create the dedicated account and persistent directories:

```sh
sudo useradd --system --home /var/lib/ai-benchmark-bot --shell /usr/sbin/nologin ai-benchmark-bot
sudo install -d -o root -g ai-benchmark-bot -m 0750 /opt/ai-benchmark-bot
sudo install -d -o ai-benchmark-bot -g ai-benchmark-bot -m 0750 /var/lib/ai-benchmark-bot
sudo install -o ai-benchmark-bot -g ai-benchmark-bot -m 0600 deploy/ai-benchmark-bot.env.example /etc/ai-benchmark-bot.env
sudo install -o root -g root -m 0644 deploy/systemd/ai-benchmark-bot.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/ai-benchmark-bot-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/ai-benchmark-bot-backup.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/ai-benchmark-bot-contract-check.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/ai-benchmark-bot-contract-check.timer /etc/systemd/system/
```

Edit `/etc/ai-benchmark-bot.env`, keeping it mode `0600`. Register the guild-scoped command before starting the service:

```sh
sudo -u ai-benchmark-bot sh -c 'set -a; . /etc/ai-benchmark-bot.env; set +a; exec /usr/bin/node /opt/ai-benchmark-bot/dist/cli.js register-commands'
sudo systemctl daemon-reload
sudo systemctl enable --now ai-benchmark-bot.service ai-benchmark-bot-backup.timer
```

## Verify and operate

```sh
systemctl status ai-benchmark-bot.service
systemctl list-timers ai-benchmark-bot-backup.timer
journalctl -u ai-benchmark-bot.service -f
sudo systemctl start ai-benchmark-bot-backup.service
```

In the Discord server, run `/benchmark setup channel`, then `/benchmark test`. The bot only requests the `Guilds` Gateway intent. In the selected notification channel grant it `View Channel`, `Send Messages`, and `Embed Links`—not Administrator or Message Content.

The backup command uses SQLite's online backup mechanism and retains the seven newest generations. Periodically test a restore on a separate database path; the presence of backup files alone is not a restore test.

Meta/Qwenを段階導入する場合は、まずJSTの異なる7日間に次のcontract checkを成功させます。

```sh
sudo systemctl enable --now ai-benchmark-bot-contract-check.timer
systemctl list-timers ai-benchmark-bot-contract-check.timer
systemctl status ai-benchmark-bot-contract-check.timer
journalctl -u ai-benchmark-bot-contract-check.service
```

timerは毎日04:15（Asia/Tokyo）に実行され、停止中に予定時刻を過ぎても`Persistent=true`により次回起動時に追いつきます。すぐに1回確認する場合は `sudo systemctl start ai-benchmark-bot-contract-check.service` を実行します。

`doctor`で各adapterの`ready`が`true`になったことを確認してから環境ファイルの`ENABLE_META` / `ENABLE_QWEN`を変更し、サービスを再起動します。contract versionが更新された場合は新しい7日間の確認が必要です。段階導入の検証を終えて定期確認が不要になった場合は `sudo systemctl disable --now ai-benchmark-bot-contract-check.timer` で停止できます。
