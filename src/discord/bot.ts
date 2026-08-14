import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type Interaction,
  type InteractionReplyOptions
} from "discord.js";
import type { BotStore } from "../application/ports.js";
import { localDateKey } from "../core/time.js";
import type { Logger } from "../core/logger.js";
import { LEADERBOARD_IDS, WATCH_TARGETS, type LeaderboardId } from "../domain/models.js";
import { LEADERBOARD_LABELS, WATCH_TARGET_LABELS } from "./commands.js";
import {
  buildChangesEmbed,
  buildRankingEmbed,
  buildStatusEmbed
} from "./embeds.js";

const REQUIRED_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
] as const;

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] }
  });
}

function hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export function requiresManageGuild(group: string | null, subcommand: string): boolean {
  return (
    group === "setup" ||
    group === "digest" ||
    (group === "watch" && subcommand !== "list") ||
    subcommand === "test"
  );
}

function channelPermissionProblem(
  interaction: ChatInputCommandInteraction,
  channel: GuildBasedChannel
): string | undefined {
  const me = interaction.guild?.members.me;
  if (!me) return "Bot自身のサーバー権限を確認できませんでした。もう一度お試しください。";
  const permissions = channel.permissionsFor(me);
  const missing = REQUIRED_CHANNEL_PERMISSIONS.filter((permission) => !permissions?.has(permission));
  if (missing.length === 0) return undefined;
  return "Botに `チャンネルを見る`、`メッセージを送信`、`埋め込みリンク` の権限が必要です。";
}

async function replyError(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
  const payload: InteractionReplyOptions = {
    content: message,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] }
  };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

export interface BenchmarkBotControllerOptions {
  client: Client;
  store: BotStore;
  token: string;
  timeZone: string;
  logger?: Logger;
  inactiveTargets?: readonly string[];
}

export class BenchmarkBotController {
  private readonly onInteraction = (interaction: Interaction) => {
    void this.handleInteraction(interaction).catch((error: unknown) => {
      this.options.logger?.error("Discord interaction failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      if (interaction.isChatInputCommand()) {
        void replyError(interaction, "コマンドの処理中にエラーが発生しました。しばらくしてから再試行してください。").catch(
          () => undefined
        );
      }
    });
  };

  public constructor(private readonly options: BenchmarkBotControllerOptions) {
    options.client.on(Events.InteractionCreate, this.onInteraction);
  }

  public async start(): Promise<void> {
    await this.options.client.login(this.options.token);
    this.options.logger?.info("Discord bot connected", {
      userId: this.options.client.user?.id
    });
  }

  public stop(): void {
    this.options.client.off(Events.InteractionCreate, this.onInteraction);
    this.options.client.destroy();
  }

  public async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "benchmark") return;
    if (!interaction.inGuild() || !interaction.guildId) {
      await replyError(interaction, "このコマンドはDiscordサーバー内でのみ利用できます。");
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    if (requiresManageGuild(group, subcommand) && !hasManageGuild(interaction)) {
      await replyError(interaction, "この操作には「サーバーを管理」権限が必要です。");
      return;
    }

    if (group === "setup" && subcommand === "channel") {
      await this.setupChannel(interaction);
      return;
    }
    if (group === "watch") {
      await this.watch(interaction, subcommand);
      return;
    }
    if (group === "digest" && subcommand === "now") {
      await this.digestNow(interaction);
      return;
    }
    if (subcommand === "ranking") {
      await this.ranking(interaction);
      return;
    }
    if (subcommand === "changes") {
      await this.changes(interaction);
      return;
    }
    if (subcommand === "status") {
      await interaction.reply({
        embeds: [buildStatusEmbed(this.options.store.listSourceStatuses())],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (subcommand === "test") {
      await this.testNotification(interaction);
      return;
    }
    await replyError(interaction, "未対応のサブコマンドです。");
  }

  private async setupChannel(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.options.getChannel("channel", true);
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      await replyError(interaction, "テキストチャンネルまたはアナウンスチャンネルを選択してください。");
      return;
    }
    if (!("guildId" in channel) || channel.guildId !== interaction.guildId) {
      await replyError(interaction, "同じDiscordサーバー内のチャンネルを選択してください。");
      return;
    }
    const problem = channelPermissionProblem(interaction, channel);
    if (problem) {
      await replyError(interaction, problem);
      return;
    }
    this.options.store.setGuildChannel(interaction.guildId!, channel.id, this.options.timeZone);
    await interaction.reply({
      content: `通知先を <#${channel.id}> に設定しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  private async watch(interaction: ChatInputCommandInteraction, subcommand: string): Promise<void> {
    const guildId = interaction.guildId!;
    if (subcommand === "list") {
      const inactive = new Set(this.options.inactiveTargets ?? []);
      const configured = new Map(
        this.options.store.listWatchTargets(guildId).map((item) => [item.target, item.enabled])
      );
      const lines = WATCH_TARGETS.map((target) => {
        if (inactive.has(target)) return `⏹️ ${WATCH_TARGET_LABELS[target]} — adapter停止`;
        const enabled = configured.get(target) ?? this.options.store.isWatchTargetEnabled(guildId, target);
        return `${enabled ? "✅" : "⏸️"} ${WATCH_TARGET_LABELS[target]}`;
      });
      await interaction.reply({
        content: lines.join("\n"),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return;
    }

    const target = interaction.options.getString("target", true);
    if (!WATCH_TARGETS.includes(target as (typeof WATCH_TARGETS)[number])) {
      await replyError(interaction, "不明な監視対象です。");
      return;
    }
    const enabled = subcommand === "enable";
    if (enabled && this.options.inactiveTargets?.includes(target)) {
      await replyError(
        interaction,
        "この段階導入adapterは環境設定で停止中です。有効化フラグを設定してBotを再起動してください。"
      );
      return;
    }
    this.options.store.setWatchTarget(guildId, target, enabled);
    await interaction.reply({
      content: `${WATCH_TARGET_LABELS[target as (typeof WATCH_TARGETS)[number]]} の監視を${enabled ? "有効" : "無効"}にしました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  private async ranking(interaction: ChatInputCommandInteraction): Promise<void> {
    const selected = interaction.options.getString("leaderboard", true);
    if (!LEADERBOARD_IDS.includes(selected as LeaderboardId)) {
      await replyError(interaction, "不明なランキングです。");
      return;
    }
    const leaderboardId = selected as LeaderboardId;
    const limit = interaction.options.getInteger("limit") ?? 10;
    await interaction.reply({
      embeds: [buildRankingEmbed(leaderboardId, this.options.store.getLeaderboard(leaderboardId, limit))],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  private async changes(interaction: ChatInputCommandInteraction): Promise<void> {
    const hours = interaction.options.getInteger("hours") ?? 24;
    const since = new Date(Date.now() - hours * 60 * 60_000).toISOString();
    const events = this.options.store.listRecentEvents(since, 100);
    await interaction.reply({
      embeds: [buildChangesEmbed(events, hours)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  private async digestNow(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const settings = this.options.store.getGuildSettings(guildId);
    if (!settings?.channelId) {
      await replyError(interaction, "先に `/benchmark setup channel` で通知先を設定してください。");
      return;
    }
    const now = new Date();
    const count = this.options.store.enqueueDigest(
      guildId,
      localDateKey(now, settings.timeZone || this.options.timeZone),
      now.toISOString(),
      true
    );
    await interaction.reply({
      content: count > 0 ? "日次ダイジェストを送信キューへ追加しました。" : "現在、ダイジェストに含める変動はありません。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  private async testNotification(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const settings = this.options.store.getGuildSettings(guildId);
    if (!settings?.channelId) {
      await replyError(interaction, "先に `/benchmark setup channel` で通知先を設定してください。");
      return;
    }
    const channel = await interaction.guild?.channels.fetch(settings.channelId).catch(() => null);
    if (!channel) {
      this.options.store.disableGuildChannel(guildId, settings.channelId);
      await replyError(interaction, "設定された通知先が見つかりません。通知先を再設定してください。");
      return;
    }
    const problem = channelPermissionProblem(interaction, channel);
    if (problem) {
      await replyError(interaction, problem);
      return;
    }
    this.options.store.enqueueTest(guildId, settings.channelId);
    await interaction.reply({
      content: `テスト通知を <#${settings.channelId}> の送信キューへ追加しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }
}
