import { REST, Routes } from "discord.js";
import type { EmbedPayload } from "./types.js";

/**
 * Sends embeds through Discord's REST API. No Gateway connection and no
 * privileged intents are needed because the bot only posts to one channel.
 */
export class DiscordNotifier {
  readonly #rest: REST;

  constructor(token: string) {
    this.#rest = new REST({ version: "10" }).setToken(token);
  }

  async sendEmbed(channelId: string, embed: EmbedPayload): Promise<void> {
    await this.#rest.post(Routes.channelMessages(channelId), {
      body: { embeds: [embed], allowed_mentions: { parse: [] } }
    });
  }
}
