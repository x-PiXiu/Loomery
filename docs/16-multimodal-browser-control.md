# 16 多模态输入与浏览器控制（P2 启动）

> 状态：设计定稿，待用户确认后分批实施
> 关联：docs/15（自主完成协议——截图是证据门的视觉形态）、ADR-0002（AI SDK 类型隔离）、docs/12（内置浏览器标签）
> 方法论：architect-handbook 整洁架构（能力裁决放适配器边界，内核 provider-agnostic）

## 0. 用户场景（北极星）

客户端（Vite）后台跑起来 → 编辑区浏览器标签打开 localhost:5173 → agent **截图**（全页/指定元素）→ **图像直接进模型** → 模型判断"布局是否合理、按钮是否可见、数据是否渲染" → **click/fill 操作页面** → 再截图验证 → task_complete。整个"看着界面调 UI"的循环不再需要人转述。

## 1. 现状核实（设计的真实约束）

- MessagePart 仅 4 种（text/summary/tool-call/tool-result），**无图像形态**
- `toModelMessages`：user content 只映射 text parts；tool output 只有 `{ type: 'text' }`
- **多模态是模型能力不是客户端能力**：MiniMax-M3.1-Flash 是文本模型——必须能力分级 + 三级降级
- Electron webview `capturePage([rect])` 支持局部截取 ✓；`executeJavaScript` 可取元素几何 ✓
- 截图经 IPC：单张 JPEG ≈ 100-250KB，与 fsReadFile 同量级通道已存在 ✓

## 2. 架构分层（依赖方向全部向内）

```
domain      MessagePart += { kind:'image', mime, base64 }；ModelConfig += vision?: boolean（能力声明）
            MessagePart(tool-result) += images?: { mime, base64 }[]   ← 内核永远携带真实数据
ports       EditorGateway += captureBrowserPage(url, rect?) → { mime, base64, width, height }
fs-tools    browser_control 工具（screenshot/click/type/scroll/read/list——浏览器标签域统一工具）
ai-sdk      translate 层：图像映射策略 = 能力裁决点（见 §3）——换模型/换供应商零内核改动
agent-core  agent-loop：ToolResult.images → tool-result part（不做任何能力判断）
ui          ToolCard 图像缩略图（点击放大）；模型条目 vision 开关 + 👁 徽章
```

**核心决策：能力裁决放适配器边界。** 多模态是"传输格式"问题而非"业务规则"问题——内核与工具始终生成/携带真实图像数据，发不发图、怎么发、降不降级由 ai-sdk translate 层按当前模型能力决定。

## 3. 三级降级链（多模态现实主义）

1. **vision=true** → 图像内联进消息（按 provider 策略映射）
2. **vision=false**（如当前 MiniMax 文本模型）→ 截图转存 artifact（用户可点开看）+ 模型侧返回页面**文本提取替代** + 提示"当前模型不支持视觉，请在模型设置切换多模态模型（如 GLM-4V/Qwen-VL/Claude/GPT-4o）"
3. **截图失败**（页面崩溃/无页面）→ innerText 文本兜底

## 4. provider 映射策略（translate 层）

| provider | 图像进消息的通道 |
|---|---|
| anthropic | tool-result block 原生支持 image ✓ 直载 |
| openai-compatible（vision） | tool 角色不支持 media → **图像以紧跟 tool 结果的 user 消息段注入**（业界通行兼容做法） |
| 任意（vision=false） | 剥离图像 → 文本注释"[截图已省略：当前模型不支持视觉]" |

## 5. browser_control 工具（浏览器标签域统一工具）

```
browser_control(action, …)：
  screenshot { url?, selector?, }   → 全页/元素截图：元素级先 scrollIntoView + getBoundingClientRect
                                       → capturePage(rect)（DIP×DPR 处理）→ resize ≤1280w → JPEG q70
  click      { url?, selector }     → executeJavaScript 派发点击（含 React 受控组件 native setter hack）
  fill       { url?, selector, text } → 设值 + input 事件（受控组件生效）
  scroll     { url?, y | selector } → 滚动到元素/坐标
  read       { url? }               → innerText（=content 的浏览器标签版）
  list                              → 当前浏览器标签清单（hostname + url）
```

- **域边界**：browser_control = 浏览器标签（webview）域；preview_control = iframe 预览域（console/reload/navigate/content）。preview_control.browser 保留为别名一个版本后废弃
- **交互沙箱**：webview 已剥离 nodeIntegration/preload ✓；不做 eval 脚本注入（click/fill/scroll 覆盖 90% 调试场景，eval 的注入面不值）
- **机器证据**：截图/click/fill 成功 → evidence kind:'preview'（完成协议证据门的视觉形态）

## 6. 尺寸与预算

- 截图 resize ≤1280 宽、JPEG q70 → 单张 ~150KB（base64 ~200KB）
- token 成本 ≈ 1400/张（1280×800）；**每轮 images ≤ 2 张**（超出转 artifact 留指针）
- UI 缩略图 180px 点击放大；usageDelta 自动计入（多模态 token 走同一条用量链）

## 7. 实施分批

- **批次 A 多模态底座（~220 行）**：domain parts/image + ModelConfig.vision + translate 三策略 + ToolResult.images + agent-loop 接线 + ToolCard 缩略图 + 模型设置 vision 开关
- **批次 B browser_control（~280 行）**：capture/交互/list + EditorGateway.captureBrowserPage + 注册表（复用 pageProvider）+ 降级链
- **批次 C 提示词与能力标记（~60 行）**：SYSTEM_BASE"页面验证工作流（截图→判断布局→操作→再截图）"+ presets 标记 vision 模型

## 8. 明确不做

- ❌ 视频/录屏、页面对象模型持久化、eval 脚本注入
- ❌ 编辑器/终端 UI 截屏（无 agent 用例——浏览器标签截屏才是验证闭环）
- ❌ 诊断推送、applyEdit 建议模式（维持 P2 parked）

## 9. 测试

- translate 三策略单测（anthropic 直载 / openai user 段注入 / 无 vision 剥离）
- browser_control 截图：webview capturePage rect 传递 mock 测试 + 真机 E2E（LOOMERY_E2E=browser：截图返回非空 base64 + 图像进 tool-result part 断言）
- 降级链：vision=false 模型跑 screenshot → artifact 存在 + 文本替代观察
