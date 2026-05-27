/**
 * 类型定义文件
 * 定义插件内部使用的接口和类型
 */

// ==================== 插件配置 ====================

/**
 * 插件主配置接口
 */
export interface PluginConfig {
    /** 全局开关：是否启用插件功能 */
    enabled: boolean;
    /** 调试模式：启用后输出详细日志 */
    debug: boolean;
    /** 管理命令前缀（help / ping / status），AI 对话使用 @ 机器人触发 */
    commandPrefix: string;
    /** @ 触发 AI 的冷却时间（秒），0 表示不限制 */
    cooldownSeconds: number;
    /** 按群的单独配置 */
    groupConfigs: Record<string, GroupConfig>;
    /** DeepSeek API 密钥 */
    apiKey: string;
    /** DeepSeek API 根地址 */
    apiUrl: string;
    /** 模型名称 */
    apiModel: string;
    /** 系统提示词（System Prompt），每次请求必带 */
    Prompt: string;
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
}

// ==================== DeepSeek API ====================

/** OpenAI 兼容 chat/completions 消息结构 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** DeepSeek 请求体 */
export interface DeepSeekChatPayload {
    model: string;
    messages: ChatMessage[];
}

// ==================== API 响应 ====================

/**
 * 统一 API 响应格式
 */
export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}
