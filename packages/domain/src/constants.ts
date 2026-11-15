// 03 §1 默认常量：全部可通过 AppConfig 覆盖
export const MAX_STEPS = 100; // 2026-11-13 用户定稿：40 对"研究+产出"型实证全触顶；100 保步（完成协议+审计续跑的余量）；纯保险
export const MAX_TURN_TOKENS = 50_000_000; // 2026-11-13 用户定稿 5000 万：token 闸退为纯保险（压缩/步数/墙钟先到，实际难触达）
export const MAX_TURN_WALL_MS = 1_800_000; // 30 分钟：步数放宽到 100 后墙钟必须同抬，否则 ~step50 先撞 10 分钟墙
export const MARGINAL_STALL_STEPS = 8; // 连续 8 步零实质产出 → 边际产出软提醒（P0④：参数各异空转的盲区治理）
export const MARGINAL_REMIND_EVERY = 4; // 首次提醒后每 4 步再提醒（advisory-only，不熔断）
export const TOOL_RESULT_CHAR_CAP = 20_000;
export const LOOP_REPEAT_THRESHOLD = 3;
/** 硬熔断阈值：达到后视为真死循环终止 Turn（软提醒给模型 2 轮自纠窗口，实证验证型重复 list_dir 被误杀） */
export const LOOP_HARD_THRESHOLD = 5;
export const CONTEXT_HASH_STREAK = 3;
export const SHORT_TERM_TOKEN_THRESHOLD = 80_000;
/** 自动压缩阈值 = 上下文窗口 × 该比例（P2：跟随模型窗口，替代写死 80K） */
export const COMPACTION_THRESHOLD_RATIO = 0.9;
export const BUDGET_WARN_RATIO = 0.8;

/** 内存治理：内核驻留全量消息的任务数上界（LRU，超出按最久未用卸载——JSONL 是事实源，随时可重建） */
export const RESIDENT_THREAD_LIMIT = 8;

/** checkpoint 快照滚动保留的最近 Turn 数（07 §5） */
export const CHECKPOINT_KEEP_TURNS = 20;
export const IMAGE_TOKEN_ESTIMATE = 1_400; // docs/16：单张截图（≤1280w JPEG）的视觉 token 固定估值（base64 不能按字符估）
export const MAX_IMAGES_PER_TURN = 8; // 每轮图像配额（含视频抽帧 6 张场景；超出剥离并转 artifact 留档）
