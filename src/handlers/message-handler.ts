/**
 * 消息处理器
 *
 * 触发方式：
 * - AI 对话：群内 @ 机器人 + 正文（如「@bot 你好」）；私聊直接发送文字
 * - 管理命令：以配置的前缀开头（默认 #cmd），如 #cmd help
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { OB11MessageDataType } from 'napcat-types/napcat-onebot/types/message';
import { pluginState } from '../core/state';
import { chatWithDeepSeek } from '../services/deepseek-service';
import { parseAtBotMessage } from '../utils/message-parse';

// ==================== CD 冷却管理 ====================

/** 冷却记录：key 为「群号:ai」，value 为过期时间戳（毫秒） */
const cooldownMap = new Map<string, number>();

/** AI 对话冷却标识 */
const AI_COOLDOWN_KEY = 'ai';

/**
 * 获取剩余冷却秒数
 * @returns 0 表示可以发起请求
 */
function getCooldownRemaining(groupId: number | string, command: string): number {
    const cdSeconds = pluginState.config.cooldownSeconds ?? 60;
    if (cdSeconds <= 0) {
        return 0;
    }

    const key = `${groupId}:${command}`;
    const expireTime = cooldownMap.get(key);
    if (!expireTime) {
        return 0;
    }

    const remaining = Math.ceil((expireTime - Date.now()) / 1000);
    if (remaining <= 0) {
        cooldownMap.delete(key);
        return 0;
    }
    return remaining;
}

/** 记录一次 AI 请求的冷却 */
function setCooldown(groupId: number | string, command: string): void {
    const cdSeconds = pluginState.config.cooldownSeconds ?? 60;
    if (cdSeconds <= 0) {
        return;
    }
    cooldownMap.set(`${groupId}:${command}`, Date.now() + cdSeconds * 1000);
}

// ==================== 消息发送工具 ====================

/**
 * 发送回复消息（自动区分群聊/私聊）
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message'],
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id
                ? { group_id: String(event.group_id) }
                : {}),
            ...(event.message_type === 'private' && event.user_id
                ? { user_id: String(event.user_id) }
                : {}),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 构建 @ 用户 + 文本 的消息段
 */
function buildAtUserReply(userId: number | string, text: string): OB11PostSendMsg['message'] {
    return [
        {
            type: OB11MessageDataType.at,
            data: { qq: userId },
        },
        {
            type: OB11MessageDataType.text,
            data: { text: ` ${text}` },
        },
    ] as OB11PostSendMsg['message'];
}

// ==================== AI 对话处理 ====================

/**
 * 处理 @ 机器人触发的 DeepSeek 对话
 */
async function handleAtBotChat(ctx: NapCatPluginContext, event: OB11Message, userText: string): Promise<void> {
    const messageType = event.message_type;
    const groupId = event.group_id;
    const userId = event.user_id;

    if (messageType === 'group' && groupId) {
        const remaining = getCooldownRemaining(groupId, AI_COOLDOWN_KEY);
        if (remaining > 0) {
            await sendReply(ctx, event, `AI 正在思考中，请等待 ${remaining} 秒后再 @ 我`);
            return;
        }
    }

    try {
        const { reply, systemPromptUsed } = await chatWithDeepSeek(userText);

        if (pluginState.config.debug) {
            pluginState.logger.debug(`本次已应用系统提示词，长度=${systemPromptUsed.length}`);
        }

        await sendReply(ctx, event, buildAtUserReply(userId, reply));

        if (messageType === 'group' && groupId) {
            setCooldown(groupId, AI_COOLDOWN_KEY);
        }
        pluginState.incrementProcessed();
    } catch (error: unknown) {
        const errText = error instanceof Error ? error.stack ?? error.message : String(error);
        pluginState.logger.error('DeepSeek 请求失败:', errText);
        await sendReply(ctx, event, '抱歉，AI 请求失败，请检查 API Key 与网络，或开启调试模式查看日志。');
    }
}

// ==================== 管理命令处理 ====================

/**
 * 处理 #cmd 前缀的管理命令（help / ping / status）
 */
async function handleAdminCommand(
    ctx: NapCatPluginContext,
    event: OB11Message,
    rawMessage: string,
): Promise<void> {
    const prefix = pluginState.config.commandPrefix || '#cmd';
    const args = rawMessage.slice(prefix.length).trim().split(/\s+/);
    const subCommand = args[0]?.toLowerCase() || '';
    const messageType = event.message_type;
    const groupId = event.group_id;

    switch (subCommand) {
        case 'help': {
            const helpText = [
                '[= DeepSeek 聊天插件 =]',
                'AI 对话：在群内 @ 机器人并输入内容，例如 @bot 你好',
                '私聊：直接发送文字即可',
                `${prefix} help   - 显示本帮助`,
                `${prefix} ping   - 测试连通性`,
                `${prefix} status - 查看运行状态`,
            ].join('\n');
            await sendReply(ctx, event, helpText);
            break;
        }

        case 'ping': {
            if (messageType === 'group' && groupId) {
                const remaining = getCooldownRemaining(groupId, 'ping');
                if (remaining > 0) {
                    await sendReply(ctx, event, `请等待 ${remaining} 秒后再试`);
                    return;
                }
            }
            await sendReply(ctx, event, 'pong!');
            if (messageType === 'group' && groupId) {
                setCooldown(groupId, 'ping');
            }
            pluginState.incrementProcessed();
            break;
        }

        case 'status': {
            const statusText = [
                '[= 插件状态 =]',
                `运行时长: ${pluginState.getUptimeFormatted()}`,
                `今日处理: ${pluginState.stats.todayProcessed}`,
                `总计处理: ${pluginState.stats.processed}`,
                `机器人 QQ: ${pluginState.selfId || '获取中...'}`,
            ].join('\n');
            await sendReply(ctx, event, statusText);
            break;
        }

        default:
            break;
    }
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理入口
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';
        const messageType = event.message_type;
        const groupId = event.group_id;

        if (pluginState.config.debug) {
            pluginState.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);
        }

        if (messageType === 'group' && groupId) {
            if (!pluginState.isGroupEnabled(String(groupId))) {
                return;
            }
        }

        const prefix = pluginState.config.commandPrefix || '#cmd';
        if (rawMessage.startsWith(prefix)) {
            await handleAdminCommand(ctx, event, rawMessage);
            return;
        }

        const { shouldTrigger, userText } = parseAtBotMessage(event);

        if (!shouldTrigger) {
            const botQQ = pluginState.selfId;
            const segments = (event as Record<string, unknown>).message;
            const hasAtOnly =
                messageType === 'group' &&
                botQQ &&
                Array.isArray(segments) &&
                (segments as Array<{ type: string; data?: { qq?: string } }>).some(
                    (s) => s.type === 'at' && String(s.data?.qq) === botQQ,
                ) &&
                userText.length === 0;

            if (hasAtOnly) {
                await sendReply(ctx, event, '请在 @ 我之后输入你想问的内容，例如：@我 你好');
            }
            return;
        }

        await handleAtBotChat(ctx, event, userText);
    } catch (error) {
        pluginState.logger.error('处理消息时出错:', error);
    }
}
