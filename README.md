# Lesson Preparing Graph · Agent-operated FLAG lesson library

> **Product overview** — an MCP-operated knowledge graph for faster, more consistent lesson preparation.

---

## 1. Introduction

**Lesson Preparing Graph** is a knowledge graph and lesson-planning workspace for teachers, currently deployed for middle-school FLAG football. The key shift is operational: **the AI agent is the primary operator**. The teacher describes the goal in Cursor; the agent searches, organises, deduplicates, stages graph changes, and prepares lesson schedules through MCP. The teacher reviews the staged result and approves it.

This replaces repetitive manual entry with repeatable batch operations, while keeping the teacher in control of everything that enters the library.

### Core capabilities

| Module | What it does |
| --- | --- |
| **Knowledge graph** | Markdown material nodes plus progression, regression, and related links; visualised as a graph and chain |
| **Agent-operated MCP** | Cursor calls search, material, link, sketch, schedule, reflection, `de_dup`, and `merge` tools instead of asking the teacher to fill repetitive forms |
| **Batch staging and approval** | New materials and connections are staged in a review session, shown as dashed nodes and edges, and committed together only after approval |
| **Semantic deduplication** | Vector search compares a proposed material with existing cards before creation; near-duplicates are folded via `de_dup` into one keeper node |
| **Merge into harder nodes** | `merge` keeps every source id and stores one harder node whose name, look, and notes are the caller's combined idea in new sentences |
| **Graph recommendations** | The agent inspects nearby or semantically similar nodes and proposes progression, regression, or related links (tag-aware) for the teacher to choose |
| **Hover-first inspection** | A two-second hover on a node, label, edge, or pending card opens the detail preview; `?peek=M…` deep links keep a node in view |
| **Timeline and calendar** | Lesson-by-lesson planning, school events, holidays, and grade schedules expose conflicts before they disrupt a lesson |
| **Notes and reflections** | Each node holds reusable notes; periods hold date-specific teaching notes and after-class reflections |
| **Agent-note library guard** | Every library file carries an `<agent-note>` banner telling agents to use MCP tools (`update_material`, `save_period`, `save_calendar`, …) instead of editing Markdown directly |

### Target users

- Middle-school PE teachers (this deployment: Grade 6/7 FLAG unit, 3 teachers, ~60 students)
- Teaching teams that want scattered lesson plans to become a reusable, progressive, searchable knowledge asset

### Tech stack

- **Frontend**: TypeScript, D3 (force-directed layout), single-page app (`web/`)
- **Backend**: Node.js + TypeScript (`server/`), REST API
- **Data**: Markdown + YAML front matter (`library/materials/`, `library/periods/`), Git-friendly and versionable
- **AI**: Cursor agent through MCP, plus Hugging Face sentence embeddings (`scripts/embed_server.py`) for semantic search and deduplication

---

## 1. 产品介绍

**Lesson Preparing Graph（备课图谱）** 是一个面向教师的知识图谱与备课工作区，当前部署于中学 FLAG 腰旗橄榄球单元。最大的变化在于操作方式：**AI agent 是主要操作者**。教师只需在 Cursor 中描述目标，agent 通过 MCP 完成检索、整理、去重、暂存图谱变更、生成课程排期；教师审阅暂存结果并批准。

这用可复用的批量操作替代了低效的手工录入，同时教师始终掌握入库的决定权。

### 核心能力

| 模块 | 功能 |
| --- | --- |
| **知识图谱** | Markdown 素材节点 + 递进（progression）、回退（regression）、关联（related）链接；以图谱和链条可视化 |
| **Agent 操作 MCP** | Cursor 调用搜索、素材、链接、草图、排期、反思、`de_dup`、`merge` 等工具，不再让教师填写重复表单 |
| **批量暂存与审批** | 新素材与链接在审阅会话中暂存，以虚线节点和虚线边展示，批准后一次性入库 |
| **语义去重** | 新建前用向量检索比对已有卡片；高度相似的重复项通过 `de_dup` 合并到一个保留节点 |
| **合并升级** | `merge` 保留每个源 id，并把调用方用新句子写出的组合想法存成一个更难的新节点（name、look、notes） |
| **图谱推荐** | Agent 检查邻近或语义相似节点，提出（带 tag 区分的）递进 / 回退 / 关联链接候选，供教师选择 |
| **悬停即详情** | 节点、标签、边或待定卡片悬停两秒即打开详情预览；`?peek=M…` 深链可让指定节点保持可见 |
| **时间线与日历** | 逐课排期、学校活动、节假日与年级课表冲突提前可见 |
| **笔记与反思** | 节点保存可复用笔记；课时保存当日的教学提示与课后反思 |
| **Agent 守护横幅** | 每个库文件带 `<agent-note>` 横幅，提醒 agent 必须走 MCP 工具（`update_material`、`save_period`、`save_calendar` 等）而不是直接改 Markdown |

### 目标用户

- 中学体育教师（本部署：六年级、七年级 FLAG 单元，3 位教师、约 60 名学生）
- 需要把「零散教案」沉淀为可复用、可递进、可检索知识资产的教学团队

### 技术栈

- **前端**：TypeScript、D3（力导向布局）、单页应用（`web/`）
- **后端**：Node.js + TypeScript（`server/`），REST API
- **数据**：Markdown + YAML 前置元数据（`library/materials/`、`library/periods/`），Git 友好、可版本管理
- **AI**：Cursor agent 通过 MCP 操作；Hugging Face 句向量（`scripts/embed_server.py`）支撑语义检索与去重

---

## 2. Design

### 2.1 Problem

Traditional lesson preparation has three pain points:

1. **Scattered understanding** — the same technique (e.g. passing) reappears in different plans and filenames; it is hard to see what makes this lesson harder than the last.
2. **Progression from memory** — teachers decide "what to add next" by experience, without an explicit easier → harder chain.
3. **Unreviewed AI output is risky** — the agent must search existing resources, stage structured operations, and wait for teacher approval.

### 2.2 Design principles

1. **Agent first, teacher in control** — the agent handles repetitive search, organisation, batch creation, and linking; the teacher makes the instructional judgement and approves.
2. **Draft before library** — `create_material`, `create_link`, and `attach_sketch` stage operations in an MCP review session; they never write Markdown directly.
3. **Game moments, not isolated skills** — `look` freezes a meaningful slice of a real 5v5 down (snap → pass → run); skill tags record the ingredients without replacing the moment.
4. **Structure plus time** — the graph explains how materials relate; the timeline and calendar explain when they can realistically be taught.
5. **Portable source of truth** — materials, periods, and calendar data remain Markdown/YAML, reviewable and Git-versionable.
6. **Library edits go through MCP** — agent-note banners, guard scripts, and hooks keep every agent on the MCP write path; the Markdown on disk is never hand-edited by automation.

### 2.3 Agent-to-library flow

```
Teacher request in Cursor
   ↓
Agent uses MCP search and planning tools
   ↓
Existing nodes, candidate links, or staged create / de_dup / merge operations
   ↓
HITL review URL: dashed graph + pending cards
   ↓
Teacher approves selected operations
   ↓
library/*.md, links, timeline, and calendar (stamped with agent-note banners)
```

### 2.4 Deduplication, merge, and recommendations

Every node in the graph is usually a **composite practice** (a game or drill). The agent reads `look`, `notes`, and skill tags to understand the game moment and its component skills rather than treating each material as an isolated skill. Skills come from a fixed **motorSkills** catalogue (see `prompts/kg-chat-system.md`): throwing and catching; snapping, handing off, and route running; running, cutting, positioning, guarding, and flag pulling.

- **`de_dup`** — before/after staging, the vector service compares `name + look + notes` against existing materials; a near-duplicate is folded into a keeper node and the redundant id is dropped.
- **`merge`** — two or more source materials become one new, harder node. The caller reads each source and writes the combined idea in new sentences. A pasted source sentence is refused. Every source id stays, and each one progresses to the new node.
- **Links** — the agent inspects semantic matches and graph neighbours, then presents candidates for a teacher decision: **progression** (target is harder), **regression** (target is easier), **related** (same level / alternative pattern, distinguished by `tag` when several related edges share a target).

```
Web research ──► Agent organises game moments
      │
      ▼
MCP search ──► vector deduplication (de_dup / merge) and candidate links
      │
      ▼
HITL draft ──► teacher review ──► approve selected batch
      │
      ▼
Markdown library ──► graph, timeline, calendar, future recommendations
```

---

## 二、设计思路

### 2.1 问题定义

传统备课存在三类痛点：

1. **理解分散**：同一技术（如传球）在不同教案、不同文件名里重复出现，难以看出「这节课比上节课难在哪里」。
2. **递进靠记忆**：教师凭经验决定「下一课加什么」，缺少显式的「更易 → 更难」链条。
3. **未审阅的 AI 产出有风险**：agent 必须先检索已有资源，把结构化操作放入暂存区，等待教师批准。

### 2.2 设计原则

1. **Agent 先行，教师把关**——agent 负责重复的检索、整理、批量创建与链接；教师做教学判断并批准。
2. **先草稿、后入库**——`create_material`、`create_link`、`attach_sketch` 只在 MCP 审阅会话中暂存，绝不在工具调用时直接写 Markdown。
3. **游戏时刻，而非孤立技能**——`look` 冻结真实 5v5 回合中有意义的一瞬（snap → pass → run）；技能标签记录组成部分，但不取代游戏时刻本身。
4. **结构 + 时间**——图谱回答「素材之间什么关系」；时间线与日历回答「什么时候真的上得了」。
5. **可移植的事实源**——素材、课时、日历数据始终是 Markdown/YAML，可审阅、可备份、可用 Git 版本管理。
6. **库的修改必须走 MCP**——agent-note 横幅、守护脚本与 hooks 保证所有 agent 都通过 MCP 写入；磁盘上的 Markdown 不允许自动化直接手改。

### 2.3 Agent 到图谱的流程

```
教师在 Cursor 中提出需求
   ↓
Agent 使用 MCP 检索与规划工具
   ↓
已有节点、候选链接，或暂存的 create / de_dup / merge 操作
   ↓
HITL 审阅页面：虚线图谱 + 待定卡片
   ↓
教师批准选中的操作
   ↓
library/*.md、链接、时间线与日历（带 agent-note 横幅）
```

### 2.4 去重、合并与推荐

图谱里的每个节点通常是**组合练习**（游戏或 drill）。Agent 读取 `look`、`notes` 和技能标签来理解游戏时刻及其组成技能，而不是把每个素材当作孤立技能。技能来自固定 **motorSkills** 目录（见 `prompts/kg-chat-system.md`）：传接球；开球、递球与跑路线；跑动、变向、站位、盯人与拔旗。

- **`de_dup`**——暂存前后，向量服务用 `name + look + notes` 与已有素材比对；高度相似的重复项被折叠进保留节点，冗余 id 被移除。
- **`merge`**——两个及以上源素材合成一个更难的新节点。调用方先读每个源，再用新句子写出组合后的想法。照搬源句会被拒绝。每个源 id 都保留，并各自递进到新节点。
- **链接**——agent 检查语义匹配与图谱邻居，提出候选让教师决定：**progression**（目标更难）、**regression**（目标更易）、**related**（同级 / 替代模式；当多条 related 边指向同一素材时用 `tag` 区分）。

```
网络调研 ──► Agent 整理为游戏时刻
      │
      ▼
MCP 检索 ──► 向量去重（de_dup / merge）与候选链接
      │
      ▼
HITL 草稿 ──► 教师审阅 ──► 批准选中的批次
      │
      ▼
Markdown 图谱库 ──► 图谱、时间线、日历、后续推荐
```

---

## 3. Recommended workflow

### 3.1 From messy research to a graph

1. Use an agent or web-search workflow to gather raw drills, game ideas, and route variations.
2. Ask the agent to organise the material into clear game moments, variations, skills, and notes.
3. Ask MCP to search the existing library before creating anything; let `de_dup` fold any near-duplicates.
4. Ask the agent to propose links between existing or newly staged nodes (use `merge` when several nodes should become one harder drill).
5. Review the returned graph page: dashed items are pending; solid items are already in the library.
6. Select individual cards or whole categories and press **Approve**.
7. Use the timeline and calendar to place lessons around school events.

### 3.2 Choosing links

- **Progression**: the target is harder than the source.
- **Regression**: the reverse direction of a progression.
- **Related**: matching information, an alternative pattern, or a same-level variation — use a `variation to ...` tag for same-level variations instead of an incorrect "harder" hop.

### 3.3 Notes, sketches, and periods

Each material stores a reusable teaching unit: `name`, `look`, `notes`, `duration`, controlled skill tags, and an optional image or video. Period files record what happened on a particular date, including class notes and reflections. Sketches and videos can be staged from local paths; they are copied into the library only when the related operation is approved.

---

## 三、推荐工作流

### 3.1 从零散调研到图谱

1. 用 agent 或联网搜索收集原始 drill、游戏创意与路线变化。
2. 让 agent 把材料整理成清晰的游戏时刻、变式、技能与笔记。
3. 创建前先让 MCP 检索现有库；让 `de_dup` 折叠高度相似的重复项。
4. 让 agent 在已有或新暂存的节点间提出链接（若多个节点应合成一个更难的练习，用 `merge`）。
5. 打开返回的图谱页审阅：虚线为待定，实线为已入库。
6. 选择单张卡片或整类操作，点击 **Approve**。
7. 用时间线与日历避开学校活动来排课。

### 3.2 选择链接

- **Progression（递进）**：目标比源更难。
- **Regression（回退）**：递进的反方向。
- **Related（关联）**：信息匹配、替代模式或同级变式——同级变式用 `variation to ...` 标签，而不是错误地建一条「更难」的边。

### 3.3 笔记、草图与课时

每个素材保存一个可复用的教学单元：`name`、`look`、`notes`、`duration`、受控技能标签，以及可选的图片或视频。课时文件记录某天实际发生的事，包括课堂笔记与反思。草图和视频可以从本地路径暂存，只在相关操作被批准后才复制入库。

---

## 4. Why this design matters

### 4.1 Protecting teacher attention

The interface protects the teacher's preparation continuum. Information appears in context: hover a node, label, edge, or pending card for two seconds and the preview opens. Long notes stay reachable without hunting through screens. Calendar and lesson-by-lesson views add a second protection: school events, holidays, and other commitments are visible before a lesson is planned into a conflict.

### 4.2 Product innovation

1. **Agent-first batch editing** instead of repetitive form entry.
2. **Game moments instead of isolated skill lists.**
3. **Vector deduplication (`de_dup`) and multi-source `merge` before/around node creation.**
4. **Human approval at the boundary between suggestion and library state.**
5. **Graph, lesson timeline, and school calendar in one planning continuum.**
6. **`?peek=` deep links** share the exact view you are discussing.
7. **Agent-note library guard** — banners, guard scripts, and hooks keep all library writes on the MCP path.
8. **Portable Markdown/YAML storage** that remains reviewable and Git-friendly.

---

## 四、设计价值

### 4.1 保护教师注意力

界面设计保证教师的备课连续性。信息在情境中呈现：节点、标签、边或待定卡片悬停两秒即打开预览；长笔记不必翻多个页面也能读到。日历与逐课视图提供第二重保护：学校活动、节假日等占用在被排进冲突之前就已可见。

### 4.2 产品创新点

1. **Agent 优先的批量编辑**，替代重复表单录入。
2. **游戏时刻**，而非孤立技能清单。
3. **向量去重（`de_dup`）与多源合并（`merge`）**，保证节点创建前后的一致性。
4. **在「建议」与「库状态」之间设置人工批准的边界。**
5. **图谱、课时时间线、学校日历同处一个规划连续体。**
6. **`?peek=` 深链**，分享正在讨论的那个视图。
7. **Agent-note 库守护**——横幅、守护脚本与 hooks 保证所有入库写入都走 MCP。
8. **可移植的 Markdown/YAML 存储**，可审阅、Git 友好。

---

## 5. MCP tools and project structure

The MCP server is in [`mcp/server.py`](mcp/server.py). Key tool families:

| Stage | Agent's role | Teacher's gatekeeping |
| --- | --- | --- |
| Architecture & scheduling | Build the unit timeline and assessment alignment from `AGENTS.md` and the school-calendar xlsx | Verify real period counts and holidays |
| Prompt engineering | Iterate `kg-chat-system.md` and SKILL files; `llm.test.ts` locks key phrasing | Test chats and correct game-moment / clarify timing |
| Graph content | Draft node copy and progression notes; propose `de_dup` / `merge` / link operations | Try lessons live, then revise look/notes via MCP |
| Documentation | This README, paper notes | Final sign-off |

### Operating principles

1. The agent searches before creating.
2. New nodes and links are staged before approval.
3. The agent never invents an existing material ID.
4. The teacher decides whether a candidate link is progression, regression, or related.
5. Library edits go through MCP only — agent-note banners and guard hooks enforce this.
6. Markdown is the source of truth; the graph is its visual explanation.

---

## 五、MCP 工具与项目结构

MCP 服务位于 [`mcp/server.py`](mcp/server.py)。主要工具族：

| 环节 | AI 参与方式 | 人的把关 |
| --- | --- | --- |
| 架构与排期 | 根据 `AGENTS.md`、校历 xlsx 生成单元时间线与评价对齐说明 | 教师核对真实课时数、节假日 |
| 提示词工程 | `kg-chat-system.md`、各 SKILL.md 由 AI 迭代；`llm.test.ts` 锁定关键句式 | 教师试聊并修正「游戏时刻」「Clarify 时机」 |
| 图谱内容 | 协助起草节点文案与递进备注；提出 `de_dup` / `merge` / 链接操作 | 教师现场试课后通过 MCP 修改 look/notes |
| 文档 | 本 README、论文笔记 | 人工定稿 |

### 运行原则

1. Agent 先检索，后创建。
2. 新节点与链接先暂存，后批准。
3. Agent 绝不凭空捏造已有素材 ID。
4. 候选链接是递进、回退还是关联，由教师决定。
5. 库的修改只走 MCP——agent-note 横幅与守护 hooks 强制执行。
6. Markdown 是事实源；图谱只是它的可视化解释。

---

## 6. Local demo

### 6.1 Run locally

```bash
# Clone
git clone https://github.com/Willie-Liao/lesson-preparing-graph.git
cd lesson-preparing-graph

# Install dependencies
npm install

# Configure API key (copy the example, add your LLM key)
cp .env.example .env

# Optional: tiny demo graph (M1–M10). Skip for a completely empty library.
npm run seed

# Build frontend and start
npm run build
npm run dev
```

Cursor starts the same services when an agent uses the lesson-library MCP. [`.cursor/mcp.json`](.cursor/mcp.json) runs `scripts/mcp_supervisor.py`: if ports 8787 / 8788 / 8789 are down it starts them before the tool call, restarts children it started, leaves already-running ports alone, and stops only its own services on shutdown. Guard helpers (`scripts/check-agent-note.ts`, `check-library-guard.py`, `install-library-guard.py`) keep the `<agent-note>` banners intact across library files.

The review UI stays at **http://localhost:8787**. Direct MCP checks stay at **http://127.0.0.1:8789/mcp**. **`library/materials/` and `library/periods/` are your local data** — the public Git repo ships an empty skeleton only; see [`library/README.md`](library/README.md).

### 6.2 Suggested demonstration

1. Ask an agent to search the web for a FLAG drill, a drill from another sport, or a practice scenario from another subject (e.g. a hotel-booking scene in language learning).
2. Ask the agent to organise the messy source into one or more teachable materials — a game moment in PE, or a task/scene in another subject.
3. Review semantic matches before allowing new cards; try `de_dup` on a near-duplicate and `merge` on two easy items that should become one harder node.
4. Ask the agent to propose or stage progression, regression, and related links.
5. Open the returned review URL and inspect dashed nodes, edges, notes, and attachments.
6. Approve selected operations, then use the graph, timeline, and calendar to plan lessons.

### 6.3 Screens

| View | Description |
| --- | --- |
| Graph | Nodes are materials; dashed nodes and edges are pending operations; `?peek=M…` keeps a node in view |
| Pending panel | Select, discard, undo, or approve staged materials and links |
| Timeline and calendar | Plan lesson stacks while seeing dates and school events |

---

## 六、本地演示

### 6.1 本地运行

```bash
# 克隆仓库
git clone https://github.com/Willie-Liao/lesson-preparing-graph.git
cd lesson-preparing-graph

# 安装依赖
npm install

# 配置 API Key（复制示例后填入大模型 Key）
cp .env.example .env

# 可选：小型演示图谱（M1–M10）。完全从空库开始则跳过。
npm run seed

# 构建前端并启动
npm run build
npm run dev
```

agent 使用 lesson-library MCP 时，Cursor 会自动启动同样的服务。[`.cursor/mcp.json`](.cursor/mcp.json) 运行 `scripts/mcp_supervisor.py`：8787 / 8788 / 8789 端口未开时先启动再执行工具调用；重启自己拉起的子进程；已在运行的端口不动；关闭时只停止自己启动的服务。守护脚本（`scripts/check-agent-note.ts`、`check-library-guard.py`、`install-library-guard.py`）保证 `<agent-note>` 横幅在库文件中不被破坏。

审阅界面在 **http://localhost:8787**。MCP 直连检查在 **http://127.0.0.1:8789/mcp**。**`library/materials/` 与 `library/periods/` 是你的本地数据**——公开 Git 仓库只带空骨架，见 [`library/README.md`](library/README.md)。

### 6.2 建议演示

1. 让 agent 联网搜索一个摇旗橄榄球运动的drill或其他的运动（其他的学科也是，比如语言学习中的一个场景，比如酒店预订）。
2. 让 agent 把零散来源整理成一个或多个可教学的素材——体育课是「比赛的关键帧」，其他学科是任务或场景。
3. 在放行新卡片前审阅语义匹配；对高度重复的卡片试 `de_dup`，对两个本应合并为更难节点的简单条目试 `merge`。
4. 让 agent 提出或暂存递进、回退、关联链接。
5. 打开返回的审阅 URL，检查虚线节点、边、笔记与附件。
6. 批准选中的操作，再用图谱、时间线和日历规划课程。

### 6.3 界面

| 视图 | 说明 |
| --- | --- |
| 图谱 | 节点即素材；虚线节点与边是待定操作；`?peek=M…` 保持指定节点可见 |
| 待定面板 | 选择、丢弃、撤销或批准暂存的素材与链接 |
| 时间线与日历 | 在看到日期与学校活动的同时排课 |

---

## 7. Repository structure

Public **lesson-preparing-graph** contains the MCP stack only (built via [`export/README.md`](export/README.md)). Your drills and lesson files stay local or in a private repo.

```
lesson-preparing-graph/
├── mcp/               # Cursor MCP server (main entry for agents)
├── server/            # REST API + storage the MCP calls
├── web/               # Graph, timeline, calendar, HITL review UI
├── prompts/           # Agent skills (explore-the-progression, create-materials, …)
├── scripts/           # dev, embed sidecar, guard scripts, tests, optional seed
├── library/           # Empty skeleton; materials/ & periods/ gitignored when filled
│   ├── materials/     # ← your M*.md (not in public clone)
│   ├── periods/       # ← your dated lessons (not in public clone)
│   └── media_library/
└── export/            # Maintainer: how the GitHub repo is produced
```

---

## 七、仓库结构

公开仓库 **lesson-preparing-graph** 只包含 MCP 技术栈（构建方式见 [`export/README.md`](export/README.md)）。你的 drill 与课程文件保留在本地或私有仓库。

```
lesson-preparing-graph/
├── mcp/               # Cursor MCP 服务（agent 主入口）
├── server/            # MCP 调用的 REST API 与存储
├── web/               # 图谱、时间线、日历、HITL 审阅界面
├── prompts/           # Agent 技能（explore-the-progression、create-materials…）
├── scripts/           # 开发脚本、向量 sidecar、守护脚本、测试、可选 seed
├── library/           # 空骨架；填充后 materials/ 与 periods/ 被 gitignore
│   ├── materials/     # ← 你的 M*.md（不在公开克隆中）
│   ├── periods/       # ← 你的带日期课时（不在公开克隆中）
│   └── media_library/
└── export/            # 维护者：GitHub 仓库如何生成
```

---

## 8. License and contact

- **Use**: educational research and non-commercial school lesson preparation
- **Repo**: https://github.com/Willie-Liao/lesson-preparing-graph
- **Author**: Willie Liao · JCID FLAG Football unit (2026–2027 Fall)

---

## 八、许可与联系

- **用途**：教育科研与非商业学校备课场景
- **仓库**：https://github.com/Willie-Liao/lesson-preparing-graph
- **作者**：Willie Liao · JCID FLAG Football 单元（2026–2027 Fall）

---

*Documentation updated: 2026-10-12 (v0.3.2)*