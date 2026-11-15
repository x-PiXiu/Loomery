// 设置页供应商预设（对齐 ZCode"添加供应商"模板网格）：baseURL/apiFormat/热门模型预填，用户只需填 key
// 图标走 brand-icons.tsx 的内联 SVG（官方品牌色 + logo 几何特征）；lucide 无品牌图标、不引第三方素材
export interface PresetModel {
  modelId: string;
  contextWindow?: number;
  displayName?: string;
  /** docs/16：视觉能力声明（设置页 👁 徽章预点亮） */
  vision?: boolean;
}

export interface ProviderPreset {
  id: string;
  name: string;
  group: '推荐' | '其他';
  baseURL: string;
  apiFormat: 'openai-compatible' | 'anthropic';
  /** 热门模型预填（选中预设即建行，可删可改） */
  models: PresetModel[];
  iconId: string;
  /** 本地供应商无需密钥（Ollama） */
  requiresKey?: boolean;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek', name: 'DeepSeek', group: '推荐',
    baseURL: 'https://api.deepseek.com/v1', apiFormat: 'openai-compatible', iconId: 'deepseek',
    models: [
      { modelId: 'deepseek-chat', contextWindow: 128_000, displayName: 'DeepSeek Chat' },
      { modelId: 'deepseek-reasoner', contextWindow: 128_000, displayName: 'DeepSeek Reasoner' },
    
      { modelId: 'deepseek-v4-flash-vision-exp', contextWindow: 128_000, displayName: 'DeepSeek V4 Vision (实验)', vision: true },],
  },
  {
    id: 'kimi', name: 'Kimi (月之暗面)', group: '推荐',
    baseURL: 'https://api.moonshot.cn/v1', apiFormat: 'openai-compatible', iconId: 'kimi',
    models: [
      { modelId: 'kimi-k2-0905-preview', contextWindow: 256_000 },
      { modelId: 'kimi-latest', contextWindow: 256_000 },
    
      { modelId: 'kimi-k3.1-pro', contextWindow: 1_000_000, displayName: 'Kimi K3.1 Pro（原生视觉）', vision: true },],
  },
  {
    id: 'minimax', name: 'MiniMax', group: '推荐',
    baseURL: 'https://api.minimaxi.com/v1', apiFormat: 'openai-compatible', iconId: 'minimax',
    models: [
      { modelId: 'MiniMax-M1', contextWindow: 1_000_000 },
      { modelId: 'MiniMax-Text-01', contextWindow: 1_000_000 },
    
      { modelId: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, displayName: 'MiniMax M3.1-Flash（原生多模态）', vision: true },],
  },
  {
    id: 'dashscope', name: '阿里云百炼', group: '推荐',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'openai-compatible', iconId: 'dashscope',
    models: [
      { modelId: 'qwen-max', contextWindow: 32_768 },
      { modelId: 'qwen-plus', contextWindow: 131_072 },
      { modelId: 'qwen-turbo', contextWindow: 1_000_000 },
    
      { modelId: 'qwen3-vl-plus', contextWindow: 1_000_000, displayName: 'Qwen3-VL-Plus（视觉）', vision: true },],
  },
  {
    id: 'mimo', name: 'Xiaomi MiMo', group: '推荐',
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', apiFormat: 'openai-compatible', iconId: 'mimo',
    models: [
      { modelId: 'mimo-v2.6-pro', contextWindow: 1_000_000 },
      { modelId: 'mimo-v2.6-flash', contextWindow: 1_000_000 },
    
      { modelId: 'mimo-v2.6-pro', contextWindow: 256_000, displayName: 'MiMo V2.6 Pro（原生全模态）', vision: true },],
    hint: 'OpenAI 兼容路径；Anthropic 格式用 /anthropic',
  },
  {
    id: 'openai', name: 'OpenAI', group: '其他',
    baseURL: 'https://api.openai.com/v1', apiFormat: 'openai-compatible', iconId: 'openai',
    models: [
      { modelId: 'gpt-4o', contextWindow: 128_000 },
      { modelId: 'gpt-4o-mini', contextWindow: 128_000 },
      { modelId: 'o3', contextWindow: 200_000 },
    
      { modelId: 'gpt-6-astra', contextWindow: 1_050_000, displayName: 'GPT-6 Astra（最强视觉）', vision: true },],
  },
  {
    id: 'anthropic', name: 'Anthropic', group: '其他',
    baseURL: 'https://api.anthropic.com', apiFormat: 'anthropic', iconId: 'anthropic',
    models: [
      { modelId: 'claude-sonnet-4-5', contextWindow: 200_000 },
      { modelId: 'claude-opus-4-1', contextWindow: 200_000 },
      { modelId: 'claude-3-5-haiku-latest', contextWindow: 200_000 },
    ],
  },
  {
    id: 'xai', name: 'xAI', group: '其他',
    baseURL: 'https://api.x.ai/v1', apiFormat: 'openai-compatible', iconId: 'xai',
    models: [
      { modelId: 'grok-4', contextWindow: 256_000 },
      { modelId: 'grok-3', contextWindow: 131_072 },
      { modelId: 'grok-3-mini', contextWindow: 131_072 },
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter', group: '其他',
    baseURL: 'https://openrouter.ai/api/v1', apiFormat: 'openai-compatible', iconId: 'openrouter',
    models: [
      { modelId: 'openai/gpt-4o', contextWindow: 128_000 },
      { modelId: 'anthropic/claude-sonnet-4.5', contextWindow: 200_000 },
      { modelId: 'deepseek/deepseek-chat', contextWindow: 128_000 },
    ],
    hint: '聚合网关：modelId 用 厂商/模型 全名',
  },
  {
    id: 'ollama', name: 'Ollama（本地）', group: '其他',
    baseURL: 'http://localhost:11434/v1', apiFormat: 'openai-compatible', iconId: 'ollama',
    models: [
      { modelId: 'qwen3', contextWindow: 128_000 },
      { modelId: 'llama3.1', contextWindow: 128_000 },
      { modelId: 'deepseek-r1', contextWindow: 128_000 },
    
      { modelId: 'qwen3-vl', contextWindow: 128_000, displayName: 'Qwen3-VL（本地视觉）', vision: true },],
    requiresKey: false,
    hint: '本地运行无需 API Key',
  },
  {
    id: 'custom', name: '创建自定义供应商', group: '其他',
    baseURL: '', apiFormat: 'openai-compatible', iconId: 'custom',
    models: [],
    requiresKey: false,
  },
];
