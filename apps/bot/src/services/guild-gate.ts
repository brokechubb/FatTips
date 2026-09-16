import { GuildMember, PermissionFlagsBits, APIInteractionGuildMember } from 'discord.js';
import { prisma } from 'fattips-database';

/**
 * Per-guild role gating for airdrops and rain.
 *
 * When a `airdropRoleId` / `rainRoleId` is set on GuildSettings, only members
 * holding that role may CREATE the feature AND only members holding that role
 * may RECEIVE/CLAIM it. When the field is null, the feature is unrestricted
 * (default behavior).
 *
 * Settings are cached for 60s to avoid a DB hit on every command.
 */

export type Feature = 'airdrop' | 'rain';

interface GateSettings {
  airdropRoleId: string | null;
  rainRoleId: string | null;
  expiresAt: number;
}

const CACHE_TTL = 60 * 1000; // 60s
const gateCache = new Map<string, GateSettings>();

/** Get (cached) gating role ids for a guild. */
export async function getGateSettings(guildId: string): Promise<GateSettings> {
  const cached = gateCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const settings = await prisma.guildSettings.findUnique({ where: { guildId } });
  const entry: GateSettings = {
    airdropRoleId: settings?.airdropRoleId ?? null,
    rainRoleId: settings?.rainRoleId ?? null,
    expiresAt: Date.now() + CACHE_TTL,
  };
  gateCache.set(guildId, entry);
  return entry;
}

/** Invalidate cached settings for a guild (call after admin updates). */
export function invalidateGateSettings(guildId: string): void {
  gateCache.delete(guildId);
}

/** Role id required to create/receive this feature, or null if unrestricted. */
export async function getRequiredRole(
  guildId: string,
  feature: Feature
): Promise<string | null> {
  const settings = await getGateSettings(guildId);
  return feature === 'airdrop' ? settings.airdropRoleId : settings.rainRoleId;
}

/** True if `member` may CREATE this feature in their guild. */
export async function canCreateFeature(
  member: GuildMember | APIInteractionGuildMember | null,
  feature: Feature
): Promise<{ allowed: boolean; reason?: string }> {
  if (!member) return { allowed: false, reason: 'This command can only be used in a server.' };

  const guildId = 'guild' in member ? (member as GuildMember).guild.id : null;
  if (!guildId) return { allowed: false, reason: 'This command can only be used in a server.' };

  const roleId = await getRequiredRole(guildId, feature);
  if (!roleId) return { allowed: true };

  // Admins always bypass the gate
  const isAdmin =
    'permissions' in member
      ? (member as GuildMember).permissions.has(PermissionFlagsBits.Administrator)
      : (member as APIInteractionGuildMember).permissions?.includes('Administrator') ?? false;
  if (isAdmin) return { allowed: true };

  const hasRole =
    'roles' in member
      ? (member as GuildMember).roles.cache.has(roleId)
      : (member as APIInteractionGuildMember).roles?.includes(roleId) ?? false;

  if (!hasRole) {
    return {
      allowed: false,
      reason: `❌ Only members with <@&${roleId}> can create ${feature}s in this server.`,
    };
  }
  return { allowed: true };
}

/** True if `member` may RECEIVE/CLAIM this feature. */
export async function canReceiveFeature(
  member: GuildMember | APIInteractionGuildMember | null,
  feature: Feature
): Promise<boolean> {
  if (!member) return false;
  const guildId = 'guild' in member ? (member as GuildMember).guild.id : null;
  if (!guildId) return false;
  const roleId = await getRequiredRole(guildId, feature);
  if (!roleId) return true;

  const isAdmin =
    'permissions' in member
      ? (member as GuildMember).permissions.has(PermissionFlagsBits.Administrator)
      : (member as APIInteractionGuildMember).permissions?.includes('Administrator') ?? false;
  if (isAdmin) return true;

  return 'roles' in member
    ? (member as GuildMember).roles.cache.has(roleId)
    : ((member as APIInteractionGuildMember).roles?.includes(roleId) ?? false);
}

/** Persist role gating config for a guild. */
export async function setGateRole(
  guildId: string,
  feature: Feature,
  roleId: string | null
): Promise<void> {
  const field = feature === 'airdrop' ? 'airdropRoleId' : 'rainRoleId';
  await prisma.guildSettings.upsert({
    where: { guildId },
    update: { [field]: roleId },
    create: { guildId, [field]: roleId },
  });
  invalidateGateSettings(guildId);
}