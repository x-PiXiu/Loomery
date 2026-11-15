// 03 §11 配置契约（域侧类型；ConfigStore 端口在 ports 包）
import type { SideEffect } from './tool';

export type ApprovalPolicy = 'auto' | 'ask' | 'deny';

/** 默认上下文窗口：未配置时按 1M 计（用户定稿） */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export interface ModelCapabilities {
  /** 该模型可接收的输入类型（P1 仅文本参与发送，image 为 P2 多模态预留） */
  input: ('text' | 'image')[];
  /** 是否输出思考链（reasoning 流） */
  reasoning?: boolean;
}

export interface ModelConfig {
  /** 供应商协议：openai-compatible（默认）/ anthropic / google… */
  provider: string;
  modelId: string;
  baseURL?: string;
  /** 密钥引用名；密钥本体在 OS 凭据库（07 §3），配置文件不落明文 */
  apiKeyRef?: string;
  /** 上下文窗口大小（tokens），供容量指示器计算占用；缺省 1M */
  contextWindow?: number;
  /** 模型能力声明（UI 展示与 P2 多模态发送校验） */
  capabilities?: ModelCapabilities;
  /** 展示名（菜单/状态栏用），缺省取 modelId */
  displayName?: string;
}

/** 模型清单条目（多供应商/多模型） */
export interface ModelEntry extends ModelConfig {
  /** 全局唯一引用 id */
  id: string;
  /** ADR：供应商为中心的管理（P2 设置重构）——禁用的模型不出现在聊天选择器，仍可测试 */
  enabled?: boolean;
}

/** 供应商条目（设置页以供应商为中心管理；模型为其子清单） */
export interface ProviderEntry {
  id: string;
  name: string;
  /** 使用的预设模板 id（preset 之一）；自定义供应商缺省 */
  preset?: string;
  baseURL: string;
  /** 供应商协议（同 ModelConfig.provider 语义） */
  apiFormat: 'openai-compatible' | 'anthropic';
  /** 密钥引用名（SecretVault）；本地供应商（如 Ollama）可缺省 */
  apiKeyRef?: string;
  /** 供应商总开关 */
  enabled: boolean;
  /** 该供应商下的模型子清单（provider 语义在供应商级 apiFormat；uid 保持旧 entry id 兼容 activeId） */
  models: (Omit<ModelConfig, 'provider'> & { uid: string; enabled?: boolean })[];
}

export interface AppConfig {
  models: {
    /** 当前生效模型（entries 中之一；缺省回退 main） */
    activeId?: string;
    /** main 档（对话）；兼容旧配置保留 */
    main: ModelConfig;
    /** cheap 档（压缩/摘要/提炼），缺省回退 main */
    cheap: ModelConfig;
    /** 模型清单（多供应商多模型）；缺省视为 [main]——providers 存在时由展平同步维护（只增不改） */
    entries?: ModelEntry[];
    /** 供应商清单（设置页数据中心结构）；与 entries 由 flattenProviders 同步 */
    providers?: ProviderEntry[];
  };
  /** 项目显示名映射（多项目：不改文件夹路径只改显示名，P2 设置重构） */
  projectNames?: Record<string, string>;
  /** 技能偏好（P2 设置重构）：disabled=从注入索引剔除（文件仍在磁盘） */
  skills?: { disabled?: string[] };
  /** 2026-11-13 Agent 人格/自定义指令（用户可在设置页编辑）：拼入 system 首段，≤4000 字符（设置页裁剪） */
  agentPersona?: string;
  /** 首次启动引导完成标记（onboarding 浮层只显示一次；可选新增字段，旧配置兼容） */
  onboardingDone?: boolean;
  approval: Record<SideEffect, ApprovalPolicy>;
  /** 会话恢复时挂起审批的处理（07 §1.3） */
  restorePolicy: 'reject' | 're-ask';
  limits: {
    maxSteps: number;
    /** 产物捕获阈值（tokens）：超过才存为产物、观察留指针；缺省 6000（P2 修复：原 1500 过低） */
    artifactThresholdTokens?: number;
    maxTurnTokens: number;
    maxWallMs: number;
    toolResultCharCap: number;
  };
  guardrails: {
    dangerousCommandPatterns: string[];
    injectionPatterns: string[];
  };
  workspaceRoots: string[];
}
