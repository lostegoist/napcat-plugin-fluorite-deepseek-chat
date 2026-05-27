/**
 * DeepSeek API 服务
 * 封装 chat/completions 请求，确保每次对话都携带系统提示词
 */

import { getEffectiveSystemPrompt } from '../config';
import { pluginState } from '../core/state';
import type { ChatMessage, DeepSeekChatPayload } from '../types';

/** DeepSeek 调用结果 */
export interface DeepSeekChatResult {
    /** 模型回复正文 */
    reply: string;
    /** 实际使用的系统提示词（便于调试核对） */
    systemPromptUsed: string;
}

/**
 * 构建发往 DeepSeek 的消息列表
 * 固定将 system 放在第一条，保证提示词每次请求都会生效
 */
export function buildChatMessages(userContent: string): ChatMessage[] {
    const systemContent = getEffectiveSystemPrompt(pluginState.config.Prompt);
    const userText = userContent.trim();
    return [
        { role: 'system', content: systemContent },
        { role: 'user', content: userText },
    ];
}

/**
 * 从 API 响应 JSON 中提取助手回复文本
 */
function extractReplyFromResponse(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') {
        return undefined;
    }
    const root = data as Record<string, unknown>;
    const choices = root.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        return undefined;
    }
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') {
        return message.content.trim();
    }
    if (typeof first.text === 'string') {
        return first.text.trim();
    }
    if (message && Array.isArray(message.content) && message.content.length > 0) {
        return String(message.content[0]).trim();
    }
    return undefined;
}

/**
 * 调用 DeepSeek 进行单轮对话
 *
 * @param userContent 用户输入（@ 机器人后的正文）
 * @returns 模型回复与本次使用的系统提示词
 */
export async function chatWithDeepSeek(userContent: string): Promise<DeepSeekChatResult> {
    const baseUrl = (pluginState.config.apiUrl || 'https://api.deepseek.com').replace(/\/+$/g, '');
    const url = `${baseUrl}/chat/completions`;
    const model = pluginState.config.apiModel || 'deepseek-chat';
    const apiKey = (pluginState.config.apiKey || '').trim();

    if (!apiKey) {
        throw new Error('未配置 API Key，请在 NapCat 插件配置或 WebUI 中填写');
    }

    const messages = buildChatMessages(userContent);
    const systemPromptUsed = messages[0].content;

    const payload: DeepSeekChatPayload = { model, messages };

    if (pluginState.config.debug) {
        const maskedKey = `${apiKey.slice(0, 4)}***`;
        pluginState.logger.debug(
            `DeepSeek 请求: url=${url}, model=${model}, apiKey=${maskedKey}, systemLen=${systemPromptUsed.length}`,
        );
        pluginState.logger.debug('DeepSeek messages:', JSON.stringify(messages));
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    const text = await response.text();

    if (pluginState.config.debug) {
        const preview = text.length > 2000 ? `${text.slice(0, 2000)}...(truncated)` : text;
        pluginState.logger.debug('DeepSeek 原始返回:', preview);
    }

    if (!response.ok) {
        let errMsg = `API 返回错误: ${response.status}`;
        try {
            const parsedErr = JSON.parse(text) as Record<string, unknown>;
            const detail = parsedErr.error ?? parsedErr.message ?? parsedErr;
            errMsg += ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
        } catch {
            errMsg += ` - ${text}`;
        }
        throw new Error(errMsg);
    }

    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (e) {
        pluginState.logger.error('解析 DeepSeek JSON 失败:', e);
        throw new Error('DeepSeek 返回内容不是合法 JSON');
    }

    const reply = extractReplyFromResponse(data);
    if (!reply) {
        pluginState.logger.error('无法解析 DeepSeek 回复，响应结构:', JSON.stringify(data));
        throw new Error('DeepSeek 返回格式无法解析');
    }

    return { reply, systemPromptUsed };
}
