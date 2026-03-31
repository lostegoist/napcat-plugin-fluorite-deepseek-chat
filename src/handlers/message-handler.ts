/**
 * 消息处理器
 *
 * 说明：
 * 该模块封装了与消息事件相关的所有功能：命令解析、权限检查、冷却管理、
 * 以及发送消息/合并转发等操作。目标是让 `handleMessage` 只负责高层业务流程，
 * 具体的发送/权限/冷却逻辑由独立函数负责，便于测试和复用。
 *
 * 注意：本文件只包含与消息事件处理直接相关的功能，复杂业务（持久化、第三方 API
 * 的高阶封装）建议拆到 service 层或单独模块中。
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { OB11MessageDataType } from 'napcat-types/napcat-onebot/types/message';

/*
 * 关于类型导入：
 * - `napcat-types` 提供 OneBot / NapCat 的类型定义，帮助在本插件中保持类型安全。
 * - 在某些环境中第三方 types 可能会引入编译问题（如果遇到，请在 tsconfig 进行隔离）。
 */

// ==================== CD 冷却管理 ====================

/** CD 冷却记录 key: `${groupId}:${command}`, value: 过期时间戳(ms) */
const cooldownMap = new Map<string, number>();

/**
 * 检查是否在 CD 中
 * @returns 剩余秒数，0 表示可用
 */
function getCooldownRemaining(groupId: number | string, command: string): number {
    // 从配置读取冷却时长（秒），若为 0 或负数则禁用冷却功能
    const cdSeconds = pluginState.config.cooldownSeconds ?? 60;
    if (cdSeconds <= 0) return 0;

    const key = `${groupId}:${command}`;
    const expireTime = cooldownMap.get(key);
    if (!expireTime) return 0;

    // 计算剩余秒数并返回；若过期则清理记录
    const remaining = Math.ceil((expireTime - Date.now()) / 1000);
    if (remaining <= 0) {
        cooldownMap.delete(key);
        return 0;
    }
    return remaining;
}

/** 设置 CD 冷却 */
function setCooldown(groupId: number | string, command: string): void {
    const cdSeconds = pluginState.config.cooldownSeconds ?? 60;
    if (cdSeconds <= 0) return;
    // 记录为到期时间戳（毫秒），便于后续比较
    cooldownMap.set(`${groupId}:${command}`, Date.now() + cdSeconds * 1000);
}

// ==================== 消息发送工具 ====================

/**
 * 发送消息（通用）
 * 根据消息类型自动发送到群或私聊
 *
 * @param ctx 插件上下文
 * @param event 原始消息事件（用于推断回复目标）
 * @param message 消息内容（支持字符串或消息段数组）
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message']
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
        // 使用 NapCat 提供的 actions 调用发送消息（适配不同 adapter）
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 发送群消息
 */
export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: String(groupId),
        };
        // 直接调用群消息发送 action
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送群消息失败:', error);
        return false;
    }
}

/**
 * 发送私聊消息
 */
export async function sendPrivateMessage(
    ctx: NapCatPluginContext,
    userId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'private',
            user_id: String(userId),
        };
        // 直接调用私聊消息发送 action
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送私聊消息失败:', error);
        return false;
    }
}

// ==================== 合并转发消息 ====================

/** 合并转发消息节点 */
/**
 * 合并转发节点结构说明：
 * - type: 固定为 'node'
 * - data.nickname: 消息来源显示名（例如机器人或用户昵称）
 * - data.user_id: 可选，来源用户 id（用于展示头像/标识）
 * - data.content: OneBot 风格的消息段数组（text/image 等）
 */
export interface ForwardNode {
    type: 'node';
    data: {
        nickname: string;
        user_id?: string;
        content: Array<{ type: string; data: Record<string, unknown> }>;
    };
}

/**
 * 发送合并转发消息
 * @param ctx 插件上下文
 * @param target 群号或用户 ID
 * @param isGroup 是否为群消息
 * @param nodes 合并转发节点列表
 */
export async function sendForwardMsg(
    ctx: NapCatPluginContext,
    target: number | string,
    isGroup: boolean,
    nodes: ForwardNode[],
): Promise<boolean> {
    try {
        const actionName = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
        const params: Record<string, unknown> = { message: nodes };
        if (isGroup) {
            params.group_id = String(target);
        } else {
            params.user_id = String(target);
        }
        // 调用合并转发 action（注意：不同 adapter 可能行为略有差异）
        await ctx.actions.call(
            actionName as 'send_group_forward_msg',
            params as never,
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        return true;
    } catch (error) {
        pluginState.logger.error('发送合并转发消息失败:', error);
        return false;
    }
}

// ==================== 权限检查 ====================

/**
 * 检查群聊中是否有管理员权限
 * 私聊消息默认返回 true
 */
export function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 * 在这里实现你的命令处理逻辑
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';
        const messageType = event.message_type;
        const groupId = event.group_id;
        const userId = event.user_id;

        // 将收到的消息记录到全局日志（便于在调试时追溯）
        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);

        // 群消息：检查该群是否在插件配置中被启用
        if (messageType === 'group' && groupId) {
            if (!pluginState.isGroupEnabled(String(groupId))) return;
        }

        // 检查是否以命令前缀开头（例如 '#cmd'），不是命令则忽略
        const prefix = pluginState.config.commandPrefix || '#cmd';
        if (!rawMessage.startsWith(prefix)) return;

        // 解析命令与参数，例如："#cmd ai 你好" => subCommand: ai, args: ['ai','你好']
        const args = rawMessage.slice(prefix.length).trim().split(/\s+/);
        const subCommand = args[0]?.toLowerCase() || '';

        //直接聊天



        // 命令分发：将不同子命令拆到独立分支处理，便于扩展
        switch (subCommand) {
            case 'help': {
                // 简单的帮助文本，建议在 WebUI 中提供更详细的说明页面
                const helpText = [
                    `[= 插件帮助 =]`,
                    `${prefix} help - 显示帮助信息`,
                    `${prefix} ping - 测试连通性`,
                    `${prefix} status - 查看运行状态`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case 'ping': {
                // ping 示例：群内存在冷却保护
                if (messageType === 'group' && groupId) {
                    const remaining = getCooldownRemaining(groupId, 'ping');
                    if (remaining > 0) {
                        await sendReply(ctx, event, `请等待 ${remaining} 秒后再试`);
                        return;
                    }
                }

                await sendReply(ctx, event, 'pong!');
                if (messageType === 'group' && groupId) setCooldown(groupId, 'ping');
                pluginState.incrementProcessed();
                break;
            }

            case 'status': {
                // 返回插件运行时统计信息，便于管理员查看
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `今日处理: ${pluginState.stats.todayProcessed}`,
                    `总计处理: ${pluginState.stats.processed}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            case 'ai': {
                // AI 聊天：将用户输入转发至 DeepSeek，并把模型返回的文本回复回群或私聊
                const prompt = args.slice(1).join(' ').trim();
                if (!prompt) {
                    await sendReply(ctx, event, '请输入你想问的问题，例如：#cmd ai 你好');
                    break;
                }

                // 群内冷却检查，避免短时间大量并发请求
                if (messageType === 'group' && groupId) {
                    const remaining = getCooldownRemaining(groupId, 'ai');
                    if (remaining > 0) {
                        await sendReply(ctx, event, `AI 正在思考中，请等待 ${remaining} 秒`);
                        return;
                    }
                }

                try {
                    // 组合 API 请求信息（注意：pluginState.config 中来自 WebUI 的配置）
                    const baseUrl = pluginState.config.apiUrl || 'https://api.deepseek.com';
                    const apiUrl = baseUrl.replace(/\/+$/g, '');
                    const url = `${apiUrl}/chat/completions`;
                    const model = pluginState.config.apiModel || 'deepseek-chat';
                    const apiKey = pluginState.config.apiKey || '';

                    // 记录调试信息（掩码 apiKey 避免泄露）
                    const maskedKey = apiKey ? `${apiKey.slice(0, 4)}***` : '(empty)';
                    pluginState.logger.debug(`DeepSeek 请求准备: url=${url}, model=${model}, apiKey=${maskedKey}`);

                    // 请求体：在 user 消息前加入一段系统提示，要求模型每次回复不超过 150 个字符
                    const systemInstruction = pluginState.config.Prompt || '你是一只小猫娘~';
                    const payload = { model, messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: prompt }
                    ] };
                    pluginState.logger.debug('DeepSeek 请求体:', JSON.stringify(payload));

                    // 发起 HTTP 请求（使用全局 fetch）
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    });

                    // 记录原始返回以便排查（过长时裁剪）
                    const text = await response.text();
                    pluginState.logger.debug('DeepSeek 原始返回:', text.length > 2000 ? text.slice(0, 2000) + '...(truncated)' : text);

                    if (!response.ok) {
                        // 尽可能从返回体中提取错误信息
                        let errMsg = `API 返回错误: ${response.status}`;
                        try {
                            const parsedErr = JSON.parse(text);
                            errMsg += ' - ' + (parsedErr.message || JSON.stringify(parsedErr));
                        } catch (e) {
                            errMsg += ' - ' + text;
                        }
                        throw new Error(errMsg);
                    }

                    // 尝试稳健地解析 JSON 并提取回复
                    let data: any = null;
                    try { data = JSON.parse(text); } catch (e) { pluginState.logger.error('解析 DeepSeek 返回 JSON 失败:', e); throw e; }

                    // 兼容不同返回结构：优先取 choices[0].message.content，其次尝试 text 字段
                    let aiReply: string | undefined;
                    if (data?.choices && Array.isArray(data.choices) && data.choices[0]) {
                        const c0 = data.choices[0];
                        if (c0.message && typeof c0.message.content === 'string') aiReply = c0.message.content;
                        else if (typeof c0.text === 'string') aiReply = c0.text;
                        else if (Array.isArray(c0.message?.content) && c0.message.content[0]) aiReply = String(c0.message.content[0]);
                    }

                    const messageContent = [
                        {
                            type: OB11MessageDataType.at,
                            data: { 
                                qq: userId 
                            }
                        },
                        {
                            type: OB11MessageDataType.text,
                            data: { 
                                text: ` ${aiReply}` 
                            }
                        }
                    ];
                    
                    if (!aiReply) {
                        // 若仍无法解析，记录完整结构用于离线排查，并给用户友好提示
                        pluginState.logger.error('无法从 DeepSeek 响应中解析出回复，响应结构:', JSON.stringify(data));
                        await sendReply(ctx, event, '抱歉，AI 返回格式无法解析。');
                    } else {
                        // 回复用户并更新冷却/统计
                        await sendReply(ctx, event, messageContent as OB11PostSendMsg['message']);
                        if (messageType === 'group' && groupId) setCooldown(groupId, 'ai');
                        pluginState.incrementProcessed();
                    }
                } catch (error: any) {
                    // 记录错误详情并通知用户
                    pluginState.logger.error('DeepSeek 请求失败:', error && error.stack ? error.stack : String(error));
                    await sendReply(ctx, event, '抱歉，AI 请求失败，请查看插件日志以获取更多信息。');
                }
                break;
            }

            default: {
                // 未知命令：当前不做处理（可以在此处增加默认行为）
                break;
            }
        }
    } catch (error) {
        // 捕获整个流程的意外异常并记录，避免抛出到上层框架
        pluginState.logger.error('处理消息时出错:', error);
    }
}
