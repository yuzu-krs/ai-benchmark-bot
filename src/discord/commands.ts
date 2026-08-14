import {
  ChannelType,
  InteractionContextType,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { LEADERBOARD_IDS, WATCH_TARGETS } from "../domain/models.js";

export const WATCH_TARGET_LABELS: Record<(typeof WATCH_TARGETS)[number], string> = {
  "lmarena-overall": "LMArena Overall",
  "lmarena-coding": "LMArena Coding",
  "swebench-verified": "SWE-bench Verified",
  "provider-openai": "OpenAI",
  "provider-anthropic": "Anthropic",
  "provider-google": "Google Gemini",
  "provider-mistral": "Mistral AI",
  "provider-xai": "xAI",
  "provider-deepseek": "DeepSeek",
  "provider-zai": "Z.ai（opt-in）",
  "provider-moonshot": "Moonshot AI / Kimi（opt-in）",
  "provider-meta": "Meta AI（段階導入）",
  "provider-qwen": "Qwen（段階導入）"
};

export const LEADERBOARD_LABELS: Record<(typeof LEADERBOARD_IDS)[number], string> = {
  "lmarena-overall": "LMArena Overall",
  "lmarena-coding": "LMArena Coding",
  "swebench-verified": "SWE-bench Verified"
};

const watchChoices = WATCH_TARGETS.map((value) => ({
  name: WATCH_TARGET_LABELS[value],
  value
}));

const leaderboardChoices = LEADERBOARD_IDS.map((value) => ({
  name: LEADERBOARD_LABELS[value],
  value
}));

export const benchmarkCommand = new SlashCommandBuilder()
  .setName("benchmark")
  .setDescription("AIベンチマークの監視設定とランキングを表示します")
  .setContexts(InteractionContextType.Guild)
  .addSubcommandGroup((group) =>
    group
      .setName("setup")
      .setDescription("Botの初期設定")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("channel")
          .setDescription("通知先チャンネルを設定します")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("通知を投稿するチャンネル")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("watch")
      .setDescription("監視対象を設定します")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("監視対象を有効にします")
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("有効にする監視対象")
              .setRequired(true)
              .addChoices(...watchChoices)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("監視対象を無効にします")
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("無効にする監視対象")
              .setRequired(true)
              .addChoices(...watchChoices)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("現在の監視設定を表示します")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("ranking")
      .setDescription("現在のランキングを表示します")
      .addStringOption((option) =>
        option
          .setName("leaderboard")
          .setDescription("表示するランキング")
          .setRequired(true)
          .addChoices(...leaderboardChoices)
      )
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("表示件数（既定: 10）")
          .setMinValue(1)
          .setMaxValue(25)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("changes")
      .setDescription("直近のランキング変動やモデル発表を表示します")
      .addIntegerOption((option) =>
        option
          .setName("hours")
          .setDescription("何時間前まで表示するか（既定: 24）")
          .setMinValue(1)
          .setMaxValue(168)
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("digest")
      .setDescription("日次ダイジェストを操作します")
      .addSubcommand((subcommand) =>
        subcommand.setName("now").setDescription("現在までのダイジェストを生成します")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("取得元ごとの監視状態を表示します")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("test")
      .setDescription("通知先へテスト通知を送ります")
  );

export const benchmarkCommandJson = benchmarkCommand.toJSON();

export interface GuildCommandRegistration {
  clientId: string;
  guildId: string;
  token: string;
  rest?: REST;
}

export async function putBenchmarkGuildCommand(input: GuildCommandRegistration): Promise<void> {
  const rest = input.rest ?? new REST({ version: "10" }).setToken(input.token);
  await rest.put(Routes.applicationGuildCommands(input.clientId, input.guildId), {
    body: [benchmarkCommandJson]
  });
}
