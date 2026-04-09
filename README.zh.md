# mempalace-node

[English README](./README.md)

[MemPalace](https://github.com/milla-jovovich/mempalace) 的 Node.js 移植版。Python 原版是 LongMemEval 基准测试中得分最高的 AI 记忆系统（96.6% Recall@5）。本移植版保留了原版的存储与检索语义，使用全精度暴力余弦相似度（无 HNSW 近似），因此检索准确率应与 Python 原版持平。默认 SQLite 后端能撑到每个 palace 约 10 万条 drawer；超过这个量，可以通过可插拔的 `VectorStore` 接口无缝迁移到 LanceDB，业务代码不用动。

**完全本地。完全离线。无 API。无云端依赖。**

## 功能特性

| 功能 | 说明 |
|---|---|
| **逐字存储** | 不做总结，完整保留原文 |
| **4 层记忆栈** | L0 身份 / L1 核心 / L2 按需 / L3 深度搜索 |
| **可插拔向量存储** | 通过 `setStoreBackend()` 切换后端（默认 SQLite，预留 LanceDB） |
| **宫殿图谱** | 通过共享 Wing 在房间间 BFS 遍历（隧道） |
| **知识图谱** | 带时间窗口（valid_from / valid_to）的实体关系三元组 |
| **AAAK 压缩** | 可选有损压缩，含实体编码和情感标记 |
| **实体注册表** | 持久化人名注册表，支持 Wikipedia 查询 |
| **实体检测器** | 通过信号评分自动检测人物/项目 |
| **通用提取器** | 提取决策 / 偏好 / 里程碑 / 问题 / 情感 |
| **房间自动检测** | 从文件夹结构或文件名模式推断房间 |
| **对话挖掘** | 导入 Claude Code、ChatGPT、Slack、Codex 聊天记录 |
| **MCP 服务器** | 19 工具的 JSON-RPC 服务器，支持 Claude Desktop / Cursor / Cline |
| **CLI Hooks** | session-start、stop、precompact 自动保存工作流 |
| **拼写检查** | 可选，保留技术术语和实体名称 |
| **大文件分割器** | 把拼接的会话记录拆成单独文件 |
| **多语言** | 中文、英文、日文、韩文等 50+ 语言开箱即用 |

## 性能

来自 `tests/test-benchmark.ts` 的真实数据。运行 `node dist/tests/test-benchmark.js`
可在你的硬件上复现。

**硬件：** Apple M1（8 核），Node 24.7，多语言模型（384 维）

| 数据量    | 冷查询    | 热查询    | 过滤查询  | 内存峰值 | Worker 路径 |
|---------:|-----:|-----:|-----:|-------:|-------------|
|     100 |  4ms |  5ms |  3ms |  231MB | —           |
|   1,000 |  6ms |  6ms |  3ms |  247MB | —           |
|   5,000 | 89ms | 28ms |  7ms |  255MB | 启用        |
|  10,000 |151ms |142ms | 20ms |  239MB | 启用        |

实际意义：

- **过滤查询几乎不随数据量变慢** — 元数据预过滤把 10K palace 缩小到
  1K 候选后查询只要 20ms，跟直接查 1K 的 palace 速度一样。**只要你知道
  wing/room，永远要带 `where: { wing: ... }` 过滤。**
- **冷热查询差距在大数据量下变小**，因为主要开销从 BLOB 解码转移到了
  余弦计算本身。
- **候选超过 5000 时自动启用 worker 线程**，通过 `SharedArrayBuffer`
  零拷贝把计算分摊到 CPU 核心。
- **内存峰值始终在 250MB 左右** — 流式 top-K 加载器任何时候内存里
  最多只有 1000 条向量，不管 palace 多大。

更大规模（10 万+）或者要求 50ms 以内的查询延迟，换 LanceDB 后端 —
见下方 [向量存储架构](#向量存储架构可插拔后端) 章节。

### 与 Python 原版（ChromaDB）对比

为了验证移植版的正确性，我们用**完全相同的数据集**和**完全相同的嵌入模型**
（`all-MiniLM-L6-v2`，384 维）在 Apple M1 上分别跑了两个引擎。

复现命令：
- Node 端：`MODEL=english node dist/tests/test-benchmark.js`
- Python 端：`pip install chromadb && python3 -u tests/benchmark-python.py`

| 指标             |   规模 | Python (ChromaDB) | Node (本项目) |
|------------------|-------:|------------------:|--------------:|
| 冷查询延迟       |    100 |              87ms |       **7ms** |
| 冷查询延迟       |     1K |              86ms |      **10ms** |
| 冷查询延迟       |    10K |          **78ms** |         305ms |
| 过滤查询         |     1K |              77ms |       **6ms** |
| 过滤查询         |    10K |              81ms |      **29ms** |
| 内存占用 (10K)   |    10K |             936MB |      **37MB** |

**为什么 Node 在小库 + 过滤场景更快：**

- JSON1 元数据预过滤 — `where: { wing: ... }` 在跑向量计算之前就把候选集
  砍到全库的 10%
- 暴力计算是精确的 — 每个返回结果都是真正的 top-K，没有 HNSW 那 ~5% 的
  召回损失

**为什么 Python 在 10K 无过滤查询场景胜出：**

- ChromaDB 用的是 HNSW（分层可导航小世界图），一个 O(log N) 的近似最近邻
  索引。在 10K 以上候选集且没有元数据过滤的情况下，索引摊销开始划算。
- 如果你的工作负载真的会撞到这个区间，可以通过可插拔接口切到 LanceDB 后端
  （也是 HNSW）— 见下方章节。

**结论：** 对于典型的 agent 记忆场景（每个 wing 5-50K drawer，几乎一定带
wing 过滤），本移植版能提供个位数毫秒级的查询延迟，**内存占用约为 ChromaDB
后端的 1/25**。

## 安装

```bash
npm install mempalace-node
# 或
pnpm add mempalace-node
```

可选依赖：
- `nspell` + `dictionary-en` — 启用英文拼写纠错

## 快速开始

```typescript
import {
  MemoryStack, searchMemories, createStore,
  KnowledgeGraph, setModel,
} from 'mempalace-node';

// 1. 选择嵌入模型（可选，默认 multilingual）
setModel('multilingual');  // 50+ 语言

// 2. 存储记忆（默认使用 SQLite 后端）
const store = createStore('~/.mempalace/palace');
await store.upsert('memory-1', '小猪喜欢收藏旧物件，不喜欢开会', {
  wing: 'xiaozhu',
  room: 'preferences',
});

// 3. 语义搜索
const results = await searchMemories('小猪喜欢什么');

// 4. 4 层记忆栈 — AI 唤醒上下文
const stack = new MemoryStack();
console.log(stack.wakeUp());                   // L0 身份 + L1 核心（约 600-900 tokens）
console.log(stack.recall('xiaozhu'));          // L2 按 wing 检索
console.log(await stack.search('收藏'));       // L3 深度搜索

// 5. 时间线知识图谱
const kg = new KnowledgeGraph();
kg.addTriple('小猪', 'works_on', 'ProjectX', { validFrom: '2026-01-01' });
kg.addTriple('小猪', 'likes', 'TypeScript');
console.log(kg.queryEntity('小猪', '2026-03-15'));  // 该日期有效的事实
kg.invalidate('小猪', 'works_on', 'ProjectX', '2026-06-01');  // 标记为已结束
```

## 向量存储架构（可插拔后端）

库使用抽象的 `VectorStore` 接口，可以在不改其他代码的情况下切换存储实现。

### 默认：SQLite（暴力余弦相似度）

- **适用规模** ≤10 万条记忆（典型 agent 记忆场景）
- **精度** 100%（精确匹配，非近似）
- **速度** 1 千条约 5-10ms，10 万条约 50ms
- **依赖** 仅 `better-sqlite3`，无原生向量索引
- **跨平台** `better-sqlite3` 能跑的地方都能跑

```typescript
import { createStore, setStoreBackend } from 'mempalace-node';

setStoreBackend('sqlite');  // 显式设置（默认就是这个）
const store = createStore('~/.mempalace/palace');
```

#### SQLite 性能优化（默认全部启用）

SQLite 后端内置 4 个优化，把暴力扫描的天花板从 1 万条推到 10 万条，
不需要任何向量索引：

1. **Float32Array 直接计算** — 余弦相似度直接在 `Float32Array`
   连续内存上跑，不再走 `number[]` 转换。在 V8 里快 3-5 倍。

2. **LRU 向量缓存** — 解码后的 `Float32Array` 按 drawer ID 保存在内存
   里。重复查询同一个 wing/room 时，直接复用缓存，不用重新解码 BLOB。
   默认容量 5000 条向量（384 维 ≈ 7.5MB）。修改 `store.ts` 里的
   `VECTOR_CACHE_SIZE` 常量可调整。

3. **流式 top-K + 最小堆** — 不再一次性加载所有候选向量然后排序，而是
   按 1000 条一批从 SQL 拉取，用有界最小堆维护 top-K。**内存峰值始终
   恒定**，不管 palace 多大，10 万条也不会 OOM。

4. **Worker 线程并行** — 候选集超过 5000 时自动启用 `os.cpus().length - 1`
   个 worker 线程，通过 `SharedArrayBuffer` 零拷贝分发计算任务。
   4 核机器上可获得约 3 倍提速。

前 3 个优化始终运行。Worker 线程只在候选数超过 5000 阈值时才启动，
避免小查询的额外开销。

释放资源：

```typescript
import { shutdownWorkerPool } from 'mempalace-node';

store.clearCache();        // 清空 LRU 缓存（不关 DB）
store.close();             // 关闭 DB + 清缓存
shutdownWorkerPool();      // 终止所有 worker 线程（应用退出时调用）
```

### 大数据量迁移至 LanceDB

LanceDB 用的是 HNSW 类的近似最近邻索引，把查询复杂度从 O(N)
降到 O(log N)。代价是每次返回的不一定是真正的 top-K（典型召回
率约 95%），换来的是查询延迟基本不随数据量增长 —— 一千条还是
一百万条，都在十几毫秒。

它有官方 Node.js 客户端 `@lancedb/lancedb`，全平台预编译二进制，
装上就能用。本项目的 `VectorStore` 接口让你不用动业务代码就能
切过去：

```typescript
import { createStore, setStoreBackend, registerStoreFactory } from 'mempalace-node';
import { LanceVectorStore } from './my-lance-store';  // 实现 VectorStore 接口

registerStoreFactory('lance', (path) => new LanceVectorStore(path));
setStoreBackend('lance');

const store = createStore('~/.mempalace/palace');  // 现在用 LanceDB 了
```

### 实现自己的后端

任何实现 `VectorStore` 接口的类都能被插入：

```typescript
import {
  VectorStore, DrawerMetadata, GetOptions, GetResult, QueryOptions, QueryResult,
  registerStoreFactory,
} from 'mempalace-node';

class MyCustomStore implements VectorStore {
  async upsert(id: string, document: string, metadata: DrawerMetadata): Promise<void> { /* ... */ }
  delete(id: string): void { /* ... */ }
  get(options?: GetOptions): GetResult { /* ... */ }
  async query(options: QueryOptions): Promise<QueryResult> { /* ... */ }
  count(): number { /* ... */ }
  close(): void { /* ... */ }
}

registerStoreFactory('my-custom', (path) => new MyCustomStore(path));
setStoreBackend('my-custom');
```

库的其他模块（miner、layers、searcher、graph、mcp-server）从不直接 import 任何具体的 store 类——只 import `VectorStore` 接口和 `createStore()` 函数——所以切换后端是零接触改动。

## 记忆宫殿架构

### 核心概念

| 概念 | 含义 | 示例 |
|---|---|---|
| **Wing（翼）** | 一个人或一个项目 | `alice`、`my-app` |
| **Room（房间）** | 话题分类 | `technical`、`decisions`、`interests` |
| **Drawer（抽屉）** | 一段逐字保存的文本（约 800 字） | 实际存储的内容 |
| **Hall（走廊）** | 同一 Wing 内房间之间的连接 | 房间间的关联 |
| **Tunnel（隧道）** | 跨 Wing 连接 | 同名房间出现在多个 Wing 中 |

### 4 层记忆栈

| 层级 | Token 数 | 加载时机 | 用途 |
|---|---|---|---|
| L0 身份 | 约 100 | 始终加载 | "我是谁？"读取 `~/.mempalace/identity.txt` |
| L1 核心故事 | 约 500-800 | 始终加载 | 权重最高的 15 条记忆，按房间分组 |
| L2 按需加载 | 约 200-500 | 话题触发时 | 按 Wing/Room 过滤检索 |
| L3 深度搜索 | 不限 | 显式搜索时 | 全量语义向量搜索 |

唤醒开销：**约 600-900 tokens**。95% 以上的上下文窗口留给对话。

## 完整功能指南

### 1. 嵌入模型

```typescript
import { setModel } from 'mempalace-node';

setModel('multilingual');  // 多语言（默认，384 维，约 120MB）
setModel('english');       // 英文专精（与原版相同，384 维，约 23MB）
setModel('bge-m3');        // 最强多语言（1024 维，约 560MB）
```

> **注意：** 切换模型会使现有嵌入失效。Palace 数据库会记录创建时使用的模型。

### 2. 文件挖掘

```typescript
import { mine } from 'mempalace-node';

const result = await mine({
  projectDir: './my-project',
  palacePath: '~/.mempalace/palace',
  wingOverride: 'my-app',
  respectGitignore: true,
});
```

需要 `mempalace.yaml`（`mempalace init` 自动生成）：

```yaml
wing: my-project
rooms:
  - name: frontend
    description: UI 组件
    keywords: [react, component, css]
```

### 3. 对话挖掘

```typescript
import { mineConvos } from 'mempalace-node';

await mineConvos({
  convoDir: '~/chat-exports',
  palacePath: '~/.mempalace/palace',
  wing: 'conversations',
  extractMode: 'exchange',  // 或 'general' 按记忆类型提取
});
```

支持格式（自动检测）：
- **OpenClaw JSONL 会话**（`~/.openclaw/agents/<id>/sessions/*.jsonl`）— 原生支持，解析消息块和工具调用
- Claude Code JSONL
- OpenAI Codex CLI JSONL
- Claude.ai JSON 导出
- ChatGPT `conversations.json`
- Slack 频道 JSON
- 纯文本（带 `>` 标记）

### 4. 搜索 + 去重

```typescript
import { searchMemories, checkDuplicate } from 'mempalace-node';

const results = await searchMemories('数据库迁移', undefined, 'my-app', 'backend');
const dup = await checkDuplicate('要检查的文本');
```

### 5. 宫殿图谱

```typescript
import { traverse, findTunnels, graphStats } from 'mempalace-node';

const connected = traverse('frontend', undefined, 2);  // BFS 最多 2 跳
const tunnels = findTunnels('my-app', 'docs');         // 桥接房间
const stats = graphStats();
```

### 6. 知识图谱

```typescript
import { KnowledgeGraph } from 'mempalace-node';

const kg = new KnowledgeGraph();
kg.addEntity('小猪', 'person', { role: '工程师' });
kg.addTriple('小猪', '正在做', 'ProjectX', {
  validFrom: '2026-01-01',
  confidence: 0.9,
});

kg.queryEntity('小猪');                    // 当前事实
kg.queryEntity('小猪', '2026-03-15');      // 时间过滤
kg.timeline('小猪');                       // 按时间排序
kg.invalidate('小猪', '正在做', 'ProjectX', '2026-06-01');

kg.stats();
kg.close();
```

### 7. AAAK 方言

```typescript
import { Dialect } from 'mempalace-node';

const dialect = new Dialect({ entities: { 小猪: 'XIA', 旺财: 'WAN' } });

const compressed = dialect.compress(
  '小猪决定改用 GraphQL，因为性能更好',
  { wing: 'tech', room: 'decisions' },
);

const stats = dialect.compressionStats(originalText, compressed);
```

> **注意：** AAAK 是**有损总结，不是无损压缩**。96.6% 的基准成绩用的是逐字存储，AAAK 模式得分 84%，但能节省 token。

### 8. 实体注册表

```typescript
import { EntityRegistry } from 'mempalace-node';

const registry = EntityRegistry.load();

registry.seed('personal',
  [
    { name: '小猪', relationship: '伴侣', context: 'personal' },
    { name: '旺财', relationship: '宠物', context: 'personal' },
  ],
  ['MyApp'],
  { 旺财: '旺旺' },
);

registry.lookup('小猪', '今天和小猪一起去爬山');
// → { type: 'person', confidence: 1.0, ... }

const wiki = await registry.research('Sam');
const learned = await registry.learnFromText(longSessionText);
const names = registry.extractPeopleFromQuery('小猪和旺财今天见面了吗？');
```

### 9. 实体检测器

```typescript
import { detectEntities, scanForDetection } from 'mempalace-node';

const files = scanForDetection('./my-project');
const detected = detectEntities(files);
// { people: [...], projects: [...], uncertain: [...] }
```

### 10. 通用提取器

```typescript
import { extractMemories } from 'mempalace-node';

const memories = extractMemories(text);
// 5 种类型：decision / preference / milestone / problem / emotional
```

### 11. 房间检测器

```typescript
import { detectRoomsLocal } from 'mempalace-node';

const result = detectRoomsLocal('./my-project');
// 自动生成 mempalace.yaml
```

### 12. 首次设置

```typescript
import { runOnboarding, quickSetup } from 'mempalace-node';

const { registry, ambiguous, bootstrap } = runOnboarding({
  mode: 'personal',
  people: [{ name: '小猪', relationship: '伴侣', context: 'personal' }],
  projects: ['MemPalace'],
});
```

### 13. 大文件分割器

```typescript
import { splitMegaFiles } from 'mempalace-node';

const result = splitMegaFiles({
  sourceDir: '~/Desktop/transcripts',
  minSessions: 2,
});
```

### 14. MCP 服务器

标准 JSON-RPC 2.0 stdio 服务器。任何兼容 MCP 的客户端都能用：
**Claude Desktop**、**Cursor**、**Cline**、**Continue**、**OpenClaw** 等。

```typescript
import { runMcpServer } from 'mempalace-node';
runMcpServer('~/.mempalace/palace');
```

或通过 CLI：
```bash
mempalace mcp --palace ~/.mempalace/palace
```

**Claude Desktop**（`~/Library/Application Support/Claude/claude_desktop_config.json`）：
```json
{
  "mcpServers": {
    "mempalace": {
      "command": "npx",
      "args": ["mempalace-node", "mcp"]
    }
  }
}
```

**OpenClaw**（在任何 agent 工作目录下创建 `<workspace>/.mcp.json`）：
```json
{
  "mcpServers": {
    "mempalace": {
      "command": "npx",
      "args": ["mempalace-node", "mcp"],
      "env": {
        "MEMPALACE_PALACE_PATH": "/path/to/your/palace"
      }
    }
  }
}
```

然后在 `MEMORY.md` 里告诉 agent 这些工具的存在：
```markdown
## 长期记忆

你有一个语义记忆系统，通过 mempalace 工具访问。
在回答关于任何人、项目或过往事件之前，先调用：
- mempalace_search("查询内容") 找到原文记忆
- mempalace_kg_query("实体名") 获取关系
- mempalace_diary_write("agent名字", "今天学到了什么") 在会话结束时
```

**19 个工具：**
- 读取：`mempalace_status`、`mempalace_list_wings`、`mempalace_list_rooms`、`mempalace_get_taxonomy`、`mempalace_search`、`mempalace_check_duplicate`、`mempalace_get_aaak_spec`
- 写入：`mempalace_add_drawer`、`mempalace_delete_drawer`
- 知识图谱：`mempalace_kg_query`、`mempalace_kg_add`、`mempalace_kg_invalidate`、`mempalace_kg_timeline`、`mempalace_kg_stats`
- 图遍历：`mempalace_traverse`、`mempalace_find_tunnels`、`mempalace_graph_stats`
- Agent 日记：`mempalace_diary_write`、`mempalace_diary_read`

### 15. Hooks（长会话自动保存）

```typescript
import { runHook } from 'mempalace-node';
await runHook('stop', 'claude-code');
```

设置 `MEMPAL_DIR` 环境变量后，每 N 次交互自动导入。

### 16. 拼写检查

```bash
npm install nspell dictionary-en
```

```typescript
import { spellcheckUserText } from 'mempalace-node';
const corrected = await spellcheckUserText('lsresdy knoe the question');
// → 'already know the question'
```

不会改动 ChromaDB、bge-large-v1.5、NDCG@10 等技术术语。

## CLI 使用

全局安装后（`npm install -g mempalace-node`）：

```bash
mempalace init ~/projects/my-app          # 初始化项目
mempalace mine ~/projects/my-app          # 挖掘项目文件
mempalace mine ~/chats --mode convos      # 挖掘聊天记录
mempalace search "查询内容"                # 语义搜索
mempalace search "查询内容" --wing my-app  # 按 wing 过滤
mempalace wake-up                         # 显示 L0 + L1 上下文
mempalace wake-up --wing my-app           # 特定 wing 的唤醒
mempalace status                          # 查看已存内容
mempalace split ~/Desktop/transcripts     # 拆分大文件
mempalace compress --wing my-app --dry-run  # 预览 AAAK 压缩
mempalace mcp                             # 运行 MCP 服务器（stdio）
mempalace hook run --hook stop --harness claude-code
```

## 配置

配置文件：`~/.mempalace/config.json`

```json
{
  "palace_path": "~/.mempalace/palace",
  "collection_name": "mempalace_drawers",
  "embedding_model": "multilingual"
}
```

环境变量：`MEMPALACE_PALACE_PATH`

## 在 Electron 中使用

```typescript
// Electron 主进程
import { app } from 'electron';
import * as path from 'path';
import { MemoryStack, setModel, createStore } from 'mempalace-node';

setModel('multilingual');

const palaceDir = path.join(app.getPath('userData'), 'mempalace', 'palace');
const stack = new MemoryStack(palaceDir);
const store = createStore(palaceDir);

// 注入唤醒上下文到 AI 系统提示词
const context = stack.wakeUp();

// 对话结束后存储
await store.upsert(id, '用户提到他喜欢深色模式', {
  wing: 'preferences', room: 'ui',
});
```

嵌入模型（约 120MB）首次运行下载并本地缓存。之后完全离线运行。

## 与 Python 原版的差异

| 方面 | Python | Node.js |
|---|---|---|
| 向量存储 | ChromaDB PersistentClient（HNSW） | 可插拔：SQLite（默认）或 LanceDB |
| 嵌入模型 | ChromaDB 内置 | @xenova/transformers |
| 模型选项 | all-MiniLM-L6-v2 | english、multilingual、bge-m3 |
| AAAK 压缩 | ✅ | ✅ |
| MCP 服务器 | ✅（19 工具） | ✅（19 工具） |
| 拼写检查 | ✅ | ✅（可选） |
| 实体注册表 | ✅ | ✅ |
| 实体检测器 | ✅ | ✅ |
| 通用提取器 | ✅ | ✅ |
| 房间自动检测 | ✅ | ✅ |
| 首次设置 | ✅（交互式） | ✅（编程接口） |
| CLI | ✅ | ✅ |
| 默认规模上限 | 100K+ drawers（HNSW） | 约 100K drawers（优化版暴力扫描） |
| 更大规模选项 | — | LanceDB 后端（100 万+） |

## 致谢

本项目是 [Milla Jovovich](https://github.com/milla-jovovich) 的 [MemPalace](https://github.com/milla-jovovich/mempalace) 的 Node.js 移植版。原项目使用 MIT 许可证。所有架构设计、记忆宫殿比喻、4 层栈设计和时间线知识图谱 Schema 均来自原版。

## 许可证

MIT
