# 17 · 代码理解插件（Code Understanding Plugin）

> 状态：设计定稿（2026-11-14），M1 待开工。本文档是该能力的唯一权威规范。
> 需求原文：帮助理解 agent 编写的代码——监控运行中程序的数据流细节、类图结构、高可交互、多语言。

## 1. 定位与北极星

把 agent 写的代码从"文本"升维成"可导航的结构 + 可观测的运行时"。
**图不是给人看的报表，而是用户、agent、运行时三方共享的操作总线**——用户指图说话，agent 按图干活。

差异化锚点：不是"代码可视化工具"，是 agent 原生的**共享坐标系**——视图状态即对话上下文，图节点即 prompt 语言。

## 2. 核心架构判断：统一协议 + 分语言探针

运行时监控没有银弹，六种机制按开销/精度排成谱系，按语言选择组合：

| # | 机制 | 精度 | 开销 | 适配语言 |
|---|---|---|---|---|
| 1 | 运行时 Hook（VM 内） | 函数级精确 | 低-中 | Java/C#/Python/JS（VM 语言专属） |
| 2 | 调试器协议 DAP | 变量/栈/表达式 | 暂停式 | C++(codelldb/lldb-dap)、Go(delve)、Rust(LLDB) |
| 3 | 编译期插桩 | 函数级精确 | 5-15% | C/C++/Rust（`-finstrument-functions`）、Go |
| 4 | 采样剖析 | 统计性 | <2% | 全语言兜底（火焰图） |
| 5 | 系统事件流 | 系统调用/函数入口 | 低 | eBPF(Linux)、ETW(Windows) |
| 6 | 全程录制回放 | 完全确定 | 2-10x | rr(Linux)、TTD(WinDbg) |

**架构落位（依赖倒置，与 Loomery 宪法同构）**：

```
domain:   RuntimeEvent 信封 + 图数据模型（本文 §4，纯类型）
ports:    ProbePort（运行时事件流）/ CodeGraphQueryPort（图查询）
adapters/inspector: ts-probe / cpp-instrument-probe / dap-adapter / lsp-client / stdout-parser
UI:       Viewer Registry 新 kind:graph + 时间线面板（渲染层）
ToolRegistry: code_map / inspect_trace 工具投影（agent 消费，source='builtin'）
```

插件形态决策：**先 builtin 形态、按插件架构设计**（独立 adapters/inspector 包+端口），将来插件化（与 MCP 同批做外挂工具源）只是换注册来源——ToolSource 'plugin' 预留缝不变。

## 3. 运行时数据获取

### 3.1 插桩机制（编译型语言的主力）

`-finstrument-functions` 是编译期改写：编译器在每个函数体首尾自动插入
`__cyg_profile_func_enter/exit` 调用。我们提供一个钩子文件（~100 行，链接进目标程序）：

```
enter(fn):  g_ringBuf.push({ now_ns(), thread_local_trace_id, fn_addr, ENTER })
exit(fn):   push EXIT
后台线程:   批量取 ring buffer → 符号还原 → JSONL/统一信封上报（目标进程内不做 IO）
```

配套：静态符号表（nm/readelf）+ `__cxa_demangle` 建地址→名称哈希表（启动时一次）；
编译参数 `-finstrument-functions -g -O1`（-O2 内联掉函数边界）；STL/三方库按路径过滤。
**Windows 事实**：GCC/Clang（含 clang-cl）支持该 flag；MSVC 原生没有——C++ 工具链选 Clang。
开销：钩子实现好百纳秒/次，热路径放大显著——给"采样/全量"档位开关；进阶替代 Google XRay（patchable call sites，关闭近零开销）。

**agent 编辑器的独特优势**：agent 项目本来就是 agent 编译的——我们控制编译命令=控制插桩注入，人手项目做不到的"保证重编译"在这里零协作成本。

### 3.2 tracepoint（值级深挖，用户方案）

断点命中→读变量→存快照→continue。两种形态天差地别：

| 形态 | 机制 | 每次命中开销 | 适用 |
|---|---|---|---|
| GDB fast tracepoint | In-Process Agent trampoline，采集在目标进程内 | 微秒级 | 高频 |
| LLDB/codelldb 断点+continue | 完整 stop→通信→resume 往返 | 1-10ms | 低频（每秒数百次内） |

分工：**插桩流做骨架（全量"经过了谁"），tracepoint 快照做深挖（"此刻变量是什么"）**——两个 ProbePort adapter，UI 无感。请求级场景（一次 HTTP 贯穿 10 节点、每秒数百请求）恰好是 tracepoint 的甜点区。

### 3.3 请求路径串联（进程内分布式追踪）

"发一个请求 → 路径流动 → 各节点记录数据变化"的正确抽象是 trace/span 模型（OpenTelemetry/Perfetto 范式）：

1. 请求入口生成 trace_id，存 thread_local 上下文
2. 插桩钩子自动携带 trace_id → 请求路径天然串成 span 树，**零代码侵入**
3. 节点数据记录两级：函数级（enter/exit+参数/返回值）、值级（tracepoint 快照读局部变量，diff 存入 span）
4. 可视化参照 Perfetto UI：时间轴 + flow 箭头流动动画 + 按 trace_id 过滤 + 点节点看详情

### 3.4 多语言映射

| 语言 | 静态结构 | 运行时观测 |
|---|---|---|
| TS/JS | 内核已有 TypeScript Compiler API（Monaco 底座） | `--import` 注入探针（fetch/http/console 猴补丁） |
| Python | pyright/pylsp（LSP） | debugpy（现成 DAP）/ sys.monitoring(3.12) |
| C/C++ | clangd（LSP）+ libclang | Clang 插桩 + codelldb（DAP tracepoint） |
| Go | gopls（LSP） | delve headless（DAP）+ runtime/trace |
| Rust | rust-analyzer（LSP） | LLDB + `-finstrument-functions`（LLVM 后端通用） |

诚实底线：每语言探针=一个适配器工程。TS/JS 深做，Python 走 debugpy，Go/C++ 按 §3.1-3.3 组合，不承诺全家桶。

## 4. 节点数据模型（先于一切 UI/存储的契约）

> 设计原则：**节点 schema 是渲染层、存储层、agent 工具层三方契约**。类型化 + 封闭枚举——agent 能看懂的前提是 schema 可校验，不是自由文本。

### 4.1 节点身份规则（nodeId）

```
nodeId = {lang}://{projectHash}/{kind}/{qualifiedName}[#{disambiguator}]
```

- `lang`：ts / js / cpp / python / go / rust（语言标记）
- `projectHash`：项目根路径哈希前 12 位——**跨项目隔离**由身份携带（对应 thread.workspaceRoot 归域）
- `qualifiedName`：语言的限定名（TS `pkg.Class`、C++ demangle 后签名、Python `module.Class`）
- `disambiguator`：模板实例/重载用参数签名区分（`OrderService.find(Order)#int`）

**稳定性铁律**：qualifiedName 是身份，`file:line` 是属性不是身份——代码移动后节点 ID 不变、位置更新。这是增量更新正确性的根基（watcher 单文件重算 = 该文件节点的位置字段 upsert，其余节点永不动）。

### 4.2 节点类型（kind，封闭枚举）

| kind | 含义 | 特有字段 |
|---|---|---|
| `module` | 文件/包 | path, childrenCount |
| `class` | 类/结构体 | extends[], implements[], isAbstract |
| `interface` | 接口/协议 | extends[] |
| `method` | 成员函数 | signature, params[], returnType, isAsync, classId |
| `function` | 自由函数 | 同上（无 classId） |
| `field` | 成员字段/属性 | type, classId |
| `endpoint` | HTTP 路由（运行时图特有） | httpMethod, route, handlerNodeId |

公共字段（所有 kind 必有）：

```
id, kind, name, lang,
file, lineStart, lineEnd,     // 属性非身份
summary,                      // ≤200 字符：doc comment/签名提取——给 agent 的"节点说明书"
visibility, modifiers,        // private/public/async/static...
updatedAt                     // 增量时间戳
```

### 4.3 边类型（封闭枚举）与证据等级

| edge kind | 含义 | 来源 |
|---|---|---|
| `contains` | 结构归属（module→class→method） | 静态 |
| `extends` / `implements` | 继承/实现 | 静态 |
| `imports` | 依赖引用 | 静态 |
| `calls` | 静态调用关系 | 静态（"可能调用"） |
| `traced-call` | **运行时实证调用** | 动态（"实际发生过"） |
| `serves` | endpoint→handler 映射 | 静态+运行时对照 |

**边带证据等级（差异化关键）**：`static`（仅静态推导）/ `dynamic`（运行时实证）/ `both`。
UI：虚线=仅静态，实线=双证，彩色流动=运行中 trace。动态边附加 weight（调用次数）、p50/p99 耗时——**热点不是猜的，是量出来的**。

### 4.4 运行时事件（RuntimeEvent 信封，与 LoopEvent 同哲学）

```
{ seq, ts, kind: fn-enter|fn-exit|trace-start|trace-end|log|snapshot|http,
  traceId, threadId, nodeId(符号还原后), payload: { args?, ret?, vars?, diff?, durationNs } }
```

折叠规则：fn-enter/exit → traced-call 边权重累计 + span 树；snapshot → 节点值级 diff 记录；
信封 schemaVersion 沿用 domain/migrations 迁移框架。

## 5. 存储设计

**SQLite（ADR-0023 引擎决策直接复用）**，新三表（全部带 projectHash 列实现跨项目隔离）：

```sql
code_nodes(id TEXT PK, project_hash TEXT, kind TEXT, name TEXT, lang TEXT,
           file TEXT, line_start INT, line_end INT, summary TEXT,
           attrs_json TEXT,        -- kind 特有字段（schema 可校验）
           updated_at INT);
code_edges(src TEXT, dst TEXT, kind TEXT, evidence TEXT,   -- static|dynamic|both
           weight INT, p50_ns INT, p99_ns INT,
           PRIMARY KEY(src, dst, kind));
span_events(seq INTEGER PK, trace_id TEXT, ts INT, node_id TEXT,
            kind TEXT, payload_json TEXT);
```

- 查询接口 = CodeGraphQueryPort：`neighbors(nodeId, depth, direction, filters)` / `search(q, kind)` / `trace(traceId)` ——**以节点为中心的局部查询**，天然抗大图爆炸（渐进披露的数据基础）
- 增量更新：watcher → 单文件改动 → 该文件节点全删重插（身份稳定保证其余节点零波及）；traced-call 统计周期合并（防边表膨胀）
- 落位：adapters/inspector 的 graph-store 实现端口；agent 工具直接消费端口

## 6. 显示规则（kind → 视觉映射，schema 的投影而非独立设计）

| kind | 形状 | 说明 |
|---|---|---|
| module | 矩形（可折叠群组） | 目录级默认折叠 |
| class | 圆角矩形 | 实线边框 |
| interface | 虚线边框矩形 | 视觉区分实现关系 |
| method/function | 椭圆 | 点开看签名+span |
| field | 小圆点 | 默认隐藏，展开类时出现 |
| endpoint | 六边形 | 运行时图入口，点击发起请求回放 |

- **颜色** = workspace 顶层目录分区色（轮转色板）——用户代码 vs 库代码一眼区分
- **边样式**：实线=both、虚线=static、粗细=weight、彩色流动动画=当前 trace 路径
- **徽章**：呼吸灯=刚被 agent 修改（watcher 联动）、红点=异常 span、数字=耗时热点
- **优先级规则**（空间有限时）：动态命中节点 > 类 > 接口 > 方法 > 字段；当前 trace 命中的路径强制展开
- **默认视图**：1 度邻居 + 目录折叠 + hover 轻量预览卡（3 行摘要）——5000 节点永不一次性渲染

## 7. 交互设计（高可交互 = 三条闭合回路）

交互性不是动画多，是**回路闭合**：每个可视元素都是操作入口，每次操作有即时反馈，每条反馈可再操作。衡量标准=认知距离（看到→理解要几步）+ 反馈延迟。

### 回路 A：图 ↔ 源码
点节点→revealLine 跳定义；点边→跳调用点；编辑器 Ctrl+点符号→图高亮+展开邻居；
agent 改码→watcher→呼吸灯标记波及面。**零语境切换**。

### 回路 B：图 ↔ 运行时
请求进入→流动光沿路径推进→节点落徽章（耗时/diff/异常）；点节点→span 详情侧栏；
点时间轴→整图回到那一刻（时间旅行 scrubbing）；右键→设 tracepoint 下次命中。
**数据流不是回放视频，是可查询的活对象。**

### 回路 C：用户 ↔ agent（agent 原生的灵魂）
框选子图→自动拼 prompt（**图状态即 prompt**）进 Composer；agent 回答引用 nodeId→图中高亮证据边；
`code_map`/`inspect_trace` 工具让 agent 查图；修复→波及面呼吸灯→审批；重跑同请求→两次 trace 对比。
**用户指图说话，agent 按图干活。**

### 五条 UI 原则
1. 渐进披露：默认 1 度邻居+折叠，双击展开，hover 预览卡
2. 一切可解释：视觉编码全图例化（流动=trace、呼吸灯=刚修改、红点=异常）
3. 三视图联动高亮（brushing & linking）：图/源码/trace 时间轴选中态同步
4. 视图状态可继承：过滤/折叠状态传给 agent 并限定回答范围——**视图状态即对话上下文**
5. 响应预算：本地查询 <100ms（SQLite 现成），重计算增量+后台，动画 GPU 合成

### 场景走查（试金石）
agent 写订单服务→启动（编译自动带插桩）→curl POST /orders→图上流动光沿
`Controller→Service→PricingRule→Repo` 推进、逐节点落徽章→PricingRule 徽章"8ms·修改 discount"
可疑→点开看 span→框选子图"为什么 VIP 算错"→agent 查 code_map/trace 回答并高亮证据边→
提交修复→波及呼吸灯→审批→重跑请求→8ms→2ms 对比。
七个动作，零语境丢失，agent 全程在场。

## 8. agent 契约（工具 schema——agent 能看懂的落地形式）

**节点 ID 就是人与 agent 对话的坐标语言**：用户框选子图，prompt 附 nodeId 列表；agent 回答用 nodeId 指称。同一坐标系，双向可读。

```
code_map 工具（read 类，source='builtin'）：
  query  { nodeId, depth=1, direction=out|in|both, kinds?[] } → 局部邻域（≤50 节点/页）
  search { q, kinds?[], lang? } → 命中节点列表（summary 字段供快速判断）
  node   { nodeId } → 完整节点+特有字段

inspect_trace 工具（read 类）：
  list   { last? } → 最近 trace 概要（入口/耗时/异常数）
  detail { traceId } → span 树（nodeId 串联）+ 值级 diff
```

输出全部为**结构化 JSON**（schema 可校验），summary 是唯一面向 agent 阅读的自然语言字段。
agent 侧零内核改动：工具经 ToolRegistry 投影，走既有审批/产物拦截管线。

## 9. 设计模式显示（诚实分级）

- 类图：LSP/Compiler API 精确提取 ✅
- 设计模式：静态结构签名检测（Observer=注册+回调接口等）精度有限——**静态候选 + 动态行为证实**两级标注
  （"观察者（已证实：观察到 3 次多播分发）" / "疑似工厂"），不当事实陈述

## 10. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| M1（~2-3 天） | TS/JS 类图：Compiler API 提取→§4 模型→SQLite→Cytoscape 渲染（viewer kind:graph）→回路 A 双向联动→code_map 工具 | 图开得开、跳得动、agent 答得出 |
| M2 | Node 运行时：--import 探针→时间线面板→run_command 自动带探针 | 请求路径流动动画+节点徽章 |
| M3 | C++/Python：Clang 插桩+codelldb（§3.1-3.3 全套）+ LSP client 适配器 | CMake 项目实弹 trace |
| M4 | 可操作层：图上 tracepoint、trace 对比、设计模式两级标注 | 回路 C 完整闭环 |

## 11. 风险与冷水

1. 插桩热路径开销 → 档位开关（采样/全量），XRay 式 patchable 进 M3 可选
2. Windows 无 eBPF → 插桩为主力（档位 3），DAP 为交互探查，ETW 仅系统级
3. 大图渲染 → §4 局部查询 + §6 默认视图规则从 M1 就写进数据模型，不是事后优化
4. 插件系统本体未建 → builtin 形态+插件架构设计，与 MCP 同批插件化
5. 模板实例化爆炸（C++）→ demangle 后按模板主名折叠；inline 函数边界消失 → -O1 编译档

## 12 · 关系模型与各图投影（2026-11-14 设计定稿）

### 12.1 总原则
- 底层**一套边模型**（code_edges），**多张投影图**——每张图 = 节点 kind 子集 + 边 kind 子集 + 布局算法；不造"一张什么都有"的大图（毛球定律）
- 关系三要素：**语义**（kind 封闭枚举）+ **证据**（evidence/confidence）+ **结构约束**（invariant，入库校验）
- 每语言实现 RelationExtractor 接口，产出**统一边词汇** → 渲染层与 agent 工具层完全语言无关

### 12.2 类图关系检测规则（TS/JS 先行，沿用 UML 语义先验）

| 关系 | UML 语义 | 检测规则（Compiler API） | 证据 | 版本 |
|---|---|---|---|---|
| contains | 结构归属 | 声明嵌套位置 | 精确 | v1，**用嵌套布局表达，不画边** |
| extends | 泛化 is-a | heritageClauses(extends) | 精确 | v1 |
| implements | 实现 | heritageClauses(implements) | 精确 | v1 |
| association | 持有引用 | 字段类型引用项目内类 | 强推导 | v1 + 多重性 |
| composition/aggregation | 生命周期绑定/共享 | 类内 new / 构造器注入 | 弱推导 | v2（启发式误报敏感，v1 统一按 association 显示） |
| dependency | 临时使用 | 参数/返回值/局部变量/静态调用引用 | 事实精确、语义弱 | ⚙️ 默认关闭（毛球第一元凶），按需开 |

- **多重性推导**：数组 → `*`；可选类型（`T?`/`T | undefined`）→ `0..1`；默认 `1`
- **结构约束**：contains 严格树（单父）；extends/implements 无环（入库校验，环=异常标记）

### 12.3 各图边模型

| 图 | 节点 | 边 | 关键规则 |
|---|---|---|---|
| 类图 | class/interface/method/field | extends/implements/association/dependency | 见 §12.2 |
| 模块依赖图 | module | imports（weight=引用数） | 环合法但高亮——环=架构坏味 |
| 调用图 | function/method | calls（静态）/ traced-call（动态，weight+p50/p99） | 自环=递归，合法 |
| 流转图（trace） | **span 实例**（traceId+spanId，与静态节点是两个身份空间） | contains（父子）/ follows（时序）/ propagate（跨线程，虚线标注） | 每 trace 一棵树；探针事件直投，零静态推导 |
| 端点图 | endpoint → handler | serves | 静态路由表 + 运行对照证实 |
| 数据流图（M4） | 值版本（var@span） | def-use / passed-as-arg / stored-to-field | tracepoint 快照 diff 推导 |

**静态/动态的认识论差异（核心认知价值）**：静态调用图=过近似（多态全展开，有假阳无漏报）；动态=精确但只见执行过的路径。
**动态证据收窄静态过近似**——agent 回答"谁调用谁"可信度的来源。traced-call 不强制 ⊆ calls（动态派发可发现静态漏项），取 union 并用 evidence 标注。

### 12.4 第一个动态实时图 = Trace 流转图
- 类图的"动态"只是增量呼吸灯（watcher 触发）——是"代码变了"，不是"程序在跑"
- 流转图结构（trace_id/span 树）由探针事件**自带**，无需静态推导 → 正确性最快兑现；也是"数据流动"承诺的第一次兑现
- 顺序：**M1 类图（+呼吸灯）→ M2 流转图（第一个真·运行时动态图）→ M2.5 调用图活权重 → M4 数据流值级**
- 跨线程诚实限制：thread_local 只保同步链，线程池断链。v1 文档化该限制；v2 提供 RAII `ScopedTrace` 供 agent 埋点传播；远期 pthread_create/线程构造插桩自动继承

### 12.5 关系表示（三层编码）
- **数据层**：edge `{src, dst, kind, evidence, confidence?, multiplicity?, weight?, decl_at?(file,line)}`——**多重边合法**（A extends B 且 A uses B 并存），(src,dst,kind) 联合主键
- **视觉层编码表**：

| 数据字段 | 视觉通道 |
|---|---|
| kind | 线端装饰+线型（UML 先验：三角=泛化/实现、菱形=聚合、开箭头=依赖/调用、虚线=实现/推导） |
| evidence | 实线=both、虚线=static-only、实线+流动动画=dynamic |
| weight | 粗细 |
| multiplicity | 线端标注 1 / * / 0..1 |
| 当前 trace / 异常 / 刚修改 | **颜色+动画**（颜色只留给状态） |

总原则：**结构用线型与箭头，状态用颜色**——颜色是稀缺资源，只标"正在发生的事"。

- **交互层**：边也可点击 → 跳 decl_at 源码行（回路 A 打到边上）；按 kind/evidence 过滤
- **agent 可读**：封闭边词汇+不变量 → agent 能区分措辞"可能调用（静态推导）"vs"实际走过（运行实证）"
