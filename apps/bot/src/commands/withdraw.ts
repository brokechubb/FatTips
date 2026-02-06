import { ChatInputCommandInteraction } from 'discord.js';
import { execute as sendExecute, withdrawData } from './send';

export const data = withdrawData;

export async function execute(interaction: ChatInputCommandInteraction) {
  return sendExecute(interaction);
}
