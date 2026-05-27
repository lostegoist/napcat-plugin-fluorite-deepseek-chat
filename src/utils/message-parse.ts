/**
 * 消息解析工具
 * 用于识别用户是否 @ 了机器人，并提取 @ 之后的对话正文
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import { pluginState } from '../core/state';

/** 消息段通用结构（OneBot 数组消息） */
interface MessageSegment {
    type: string;
    data?: Record<string, unknown>;
}

/** @ 解析结果 */
export interface AtBotParseResult {
    /** 是否满足触发条件（群聊须 @ 机器人；私聊视为直接对话） */
    shouldTrigger: boolean;
    /** 去掉 @ 段后的用户输入正文 */
    userText: string;
}

/**
 * 获取机器人 QQ 号
 * 优先使用 pluginState.selfId，其次使用事件自带的 self_id
 */
function resolveBotQQ(event: OB11Message): string {
    if (pluginState.selfId) {
        return pluginState.selfId;
    }
    const selfId = (event as Record<string, unknown>).self_id;
    if (selfId !== undefined && selfId !== null) {
        return String(selfId);
    }
    return '';
}

/**
 * 判断消息段数组中是否包含对机器人的 @
 */
function hasAtBotInSegments(segments: MessageSegment[], botQQ: string): boolean {
    if (!botQQ) {
        return false;
    }
    return segments.some((seg) => {
        if (seg.type !== 'at') {
            return false;
        }
        const qq = seg.data?.qq;
        return String(qq) === botQQ;
    });
}

/**
 * 从 raw_message 中检测是否 @ 了机器人（兼容 CQ 码格式）
 */
function hasAtBotInRaw(rawMessage: string, botQQ: string): boolean {
    if (!botQQ || !rawMessage) {
        return false;
    }
    const cqPattern = new RegExp(`\\[CQ:at,qq=${botQQ}(?:,[^\\]]*)?\\]`, 'i');
    return cqPattern.test(rawMessage);
}

/**
 * 从消息段数组提取文本，并跳过指向机器人的 @ 段
 */
function extractTextFromSegments(segments: MessageSegment[], botQQ: string): string {
    const parts: string[] = [];
    for (const seg of segments) {
        if (seg.type === 'at' && botQQ && String(seg.data?.qq ?? '') === botQQ) {
            continue;
        }
        if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            parts.push(seg.data.text);
        }
    }
    return parts.join('').trim();
}

/**
 * 从 raw_message 提取文本，并移除对机器人的 CQ at 段
 */
function extractTextFromRaw(rawMessage: string, botQQ: string): string {
    let text = rawMessage;
    if (botQQ) {
        text = text.replace(new RegExp(`\\[CQ:at,qq=${botQQ}(?:,[^\\]]*)?\\]`, 'gi'), '');
    }
    return text.trim();
}

/**
 * 从事件中提取纯文本内容（优先 message 数组，回退 raw_message）
 */
function extractPlainText(event: OB11Message, botQQ: string): string {
    const messageField = (event as Record<string, unknown>).message;
    if (Array.isArray(messageField) && messageField.length > 0) {
        return extractTextFromSegments(messageField as MessageSegment[], botQQ);
    }
    return extractTextFromRaw(event.raw_message || '', botQQ);
}

/**
 * 解析消息是否应触发 AI 对话，并提取用户正文
 *
 * 规则：
 * - 群聊：必须 @ 机器人，且 @ 后存在非空文本（例如「@bot 你好」）
 * - 私聊：无需 @，整条消息作为用户输入
 */
export function parseAtBotMessage(event: OB11Message): AtBotParseResult {
    const botQQ = resolveBotQQ(event);
    const userText = extractPlainText(event, botQQ);

    if (event.message_type === 'private') {
        return {
            shouldTrigger: userText.length > 0,
            userText,
        };
    }

    const segments = (event as Record<string, unknown>).message;
    const rawMessage = event.raw_message || '';
    let mentioned = false;

    if (Array.isArray(segments) && segments.length > 0) {
        mentioned = hasAtBotInSegments(segments as MessageSegment[], botQQ);
    }
    if (!mentioned) {
        mentioned = hasAtBotInRaw(rawMessage, botQQ);
    }

    return {
        shouldTrigger: mentioned && userText.length > 0,
        userText,
    };
}
