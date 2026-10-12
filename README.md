# Lesson Preparing Graph · Agent-operated FLAG lesson library

> **Product overview** — an MCP-operated knowledge graph for faster, more consistent FLAG lesson preparation.

---

## 一、产品介绍

**Lesson Preparing Graph** is a knowledge graph and lesson-planning workspace for teachers, currently configured for middle-school FLAG football. The major change is operational: the **AI agent is the main operator**. The teacher describes the goal in Cursor; the agent searches, organises, deduplicates, stages graph changes, and prepares lesson schedules through MCP. The teacher reviews the staged result and approves it.

This replaces low-efficiency manual entry with repeatable batch operations while keeping the teacher in control of what enters the library.

### Core capabilities

| 模块 | 功能 |
| --- | --- |
| **Knowledge graph** | Markdown material nodes plus progression, regression, and related links; visualised as a graph and chain |
| **Agent-operated MCP** | Cursor calls search, material, link, sketch, schedule, and reflection tools instead of asking the teacher to fill repetitive forms |
| **Batch staging and approval** | New materials and connections are staged in a review session, shown as dashed nodes and edges, and committed together only after approval |
| **Semantic deduplication** | Vector search compares a proposed material with existing cards before creation; sufficiently similar nodes are not duplicated |
| **Graph recommendations** | The agent can inspect nearby or semantically similar nodes and propose progression, regression, or related links for the teacher to choose |
| **Hover-first inspection** | A two-second hover on a node, label, edge, or pending card opens the detail preview without requiring the teacher to search through the interface |
| **Timeline and calendar** | Lesson-by-lesson planning, school events, holidays, and grade schedules expose conflicts before they disrupt a lesson |
| **Notes and reflections** | Each node can hold reusable notes, while periods can hold date-specific teaching notes and after-class reflections |

### 目标用户

- 中学体育教师（本部署：六年级、七年级 FLAG 单元，3 位教师、约 60 名学生）
- 需要把「零散教案」沉淀为可复用、可递进、可检索的知识资产的教学团队

### 技术栈

- **前端**：TypeScript、D3（力导向布局）、单页应用（`web/`）
- **后端**：Node.js + TypeScript（`server/`），REST API
- **数据**：Markdown + YAML 前置元数据（`library/materials/`、`library/periods/`），Git 友好、可版本管理
- **AI**：Cursor agent through MCP, plus Hugging Face sentence embeddings (`scripts/embed_server.py`) for semantic search and deduplication

---

## 二、设计思路

### 2.1 问题定义

传统备课存在三类痛点：

1. **理解分散**：同一技术（如传球）在不同教案、不同文件名里重复出现，难以看出「这节课比上节课难在哪里」。
2. **递进靠记忆**：教师凭经验决定「下一课加什么」，缺少显式的「更易 → 更难」链条。
3. **Unreviewed AI output is risky**：the agent must search existing resources, stage structured operations, and wait for teacher approval.

### 2.2 Design principles

1. **Agent first, teacher in control**
   The agent handles repetitive search, organisation, batch creation, and linking. The teacher decides what is instructionally correct and approves the staged changes.

2. **Draft before library**
   `create_material`, `create_link`, and `attach_sketch` stage operations in an MCP review session. They never write Markdown on the tool call.

3. **Game moments, not isolated skills**
   `look` freezes a meaningful slice of a real 5v5 down, such as snap → pass → run. Skill tags record the ingredients without replacing the game moment.

4. **Structure plus time**
   The graph explains how materials relate. The timeline and calendar explain when they can realistically be taught.

5. **Portable source of truth**
   Materials, periods, and calendar data remain Markdown/YAML files that can be reviewed, backed up, and versioned with Git.

### 2.3 Agent-to-library flow

```
Teacher request in Cursor
       ↓
Agent uses MCP search and planning tools
       ↓
Existing nodes, candidate links, or staged create operations
       ↓
HITL review URL: dashed graph + pending cards
       ↓
Teacher approves selected operations
       ↓
library/*.md, links, timeline, and calendar
```

### 2.4 Semantic deduplication and agent recommendations

图谱里的每个节点通常是**组合练习**（游戏或 drill）。Agent reads `look`, `notes`, and skill tags to understand the game moment and the component skills, rather than treating every material as a disconnected skill.

- Throwing and catching
- Snapping, handing off, and route running
- Running, cutting, positioning, guarding, and flag pulling

这些技能来自固定 **motorSkills** 目录（见 `prompts/kg-chat-system.md`），与「5v5 游戏时刻」并存：对外展示仍是完整 drill；对内图谱知道它已经隐含哪些基本功。

Before a new node is staged, the vector service compares `name + look + notes` against existing materials. If the similarity is high enough, the proposed duplicate is discarded instead of creating another node. This is the key consistency mechanism for batch work.

For links, the agent can inspect semantic matches and graph neighbours, then present candidates for a teacher decision:

- **progression** — the target is harder;
- **regression** — the target is easier;
- **related** — the same level, an alternative pattern, or another useful connection.

The agent stages the selected link; it does not silently decide the pedagogical relationship or write directly to the library.

```
Web research ──► Agent organises game moments
        │
        ▼
MCP search ──► vector deduplication and candidate links
        │
        ▼
HITL draft ──► teacher review ──► approve selected batch
        │
        ▼
Markdown library ──► graph, timeline, calendar, future recommendations
```

---

## 3. Recommended workflow

### 3.1 From messy research to a graph

1. Use an agent or web-search workflow to gather raw drills, game ideas, and route variations.
2. Ask the agent to organise the material into clear game moments, variations, skills, and notes.
3. Ask MCP to search the existing library before creating anything.
4. Ask the agent to propose links between existing or newly staged nodes.
5. Review the returned graph page: dashed items are pending; solid items are already in the library.
6. Select individual cards or whole categories and press **Approve**.
7. Use the timeline and calendar to place lessons around school events.

The agent can batch many related operations consistently. The teacher’s attention is reserved for instructional judgement rather than repeated typing, copying, and checking.

### 3.2 Choosing links

- **Progression**: the target is harder than the source.
- **Regression**: the reverse direction of a progression.
- **Related**: matching information, an alternative pattern, or a same-level variation.

The agent should inspect existing links before proposing a new one. It should use a `variation to ...` tag for same-level variations rather than incorrectly creating a harder hop.

### 3.3 Notes, sketches, and periods

Each material stores a reusable teaching unit: `name`, `look`, `notes`, `duration`, controlled skill tags, and an optional image or video. Period files record what happened on a particular date, including class notes and reflections. This separates the stable drill description from the changing reality of a lesson.

Sketches and videos can be staged from local paths. They are copied into the library only when the related operation is approved.

---

## 4. Why the refactor matters

### 4.1 Protecting teacher attention

| 维度 | 说明 |
| --- | --- |
The interface is designed to protect the teacher’s preparation continuum. Information is shown in context: hover a node, label, edge, or pending card for two seconds and the preview opens. Long notes remain available without forcing the teacher to search through several screens.

Calendar and lesson-by-lesson views add a second protection: school events, holidays, and other commitments are visible before a lesson is planned into a conflict.

### 4.2 Product innovation

1. **Agent-first batch editing** instead of repetitive form entry.

2. **Game moments instead of isolated skill lists.**

3. **Vector deduplication before a new node is staged.**

4. **Human approval at the boundary between suggestion and library state.**

5. **Graph, lesson timeline, and school calendar in one planning continuum.**

6. **Portable Markdown/YAML storage** that remains reviewable and Git-friendly.

---

## 5. MCP tools and project structure

The MCP server is in [`mcp/server.py`](mcp/server.py). Important tool families include:

| 环节 | AI 参与方式 | 人的把关 |
| --- | --- | --- |
| **架构与排期** | 根据 `AGENTS.md`、校历 xlsx 生成单元时间线与评价对齐说明 | 教师核对真实课时数、节假日 |
| **提示词工程** | `kg-chat-system.md`、各 SKILL.md 由 AI 迭代；单元测试 `llm.test.ts` 锁定关键句式 | 教师试聊并修正「游戏时刻」「Clarify 时机」 |
| **图谱内容** | 协助起草 M103–M106 等节点文案与 progression 备注 | 教师现场试课 후修改 look/notes |
| **文档** | 本 README、论文笔记 `paper/material_graph.md` | 人工定稿 |

### Operating principles

1. The agent searches before creating.
2. New nodes and links are staged before approval.
3. The agent never invents an existing material ID.
4. The teacher decides whether a candidate link is progression, regression, or related.
5. Markdown is the source of truth; the graph is its visual explanation.

---

## 6. Local demo

### 6.1 Run locally

```bash
# 克隆仓库
git clone https://github.com/Willie-Liao/lesson-preparing-graph.git
cd lesson-preparing-graph

# 安装依赖
npm install

# 配置 API Key（复制示例后填入大模型 Key）
cp .env.example .env

# Optional: tiny demo graph (M1–M10). Skip for a completely empty library.
npm run seed

# 构建前端并启动
npm run build
npm run dev
```

Cursor starts the same services when an agent uses the lesson-library MCP. [`.cursor/mcp.json`](.cursor/mcp.json) runs `scripts/mcp_supervisor.py`. If ports 8787, 8788, or 8789 are down, that command starts them before the tool call. A child that this process started is restarted after it exits. An already-running port is left in place, so a second launch does not bind it again. Closing the MCP process stops only the services that process started.

The review UI stays at **http://localhost:8787**. Direct MCP checks stay at **http://127.0.0.1:8789/mcp**. **`library/materials/` and `library/periods/` are your local data** — the public Git repo ships an empty skeleton only; see [`library/README.md`](library/README.md).

### 6.2 Suggested demonstration

1. Ask an agent to search the web for a FLAG drill or game pattern.
2. Ask the agent to organise the messy source into one or more game-moment materials.
3. Review semantic matches before allowing new cards.
4. Ask the agent to propose or stage progression, regression, and related links.
5. Open the returned review URL and inspect dashed nodes, edges, notes, and attachments.
6. Approve selected operations, then use the graph, timeline, and calendar to plan lessons.

### 6.3 Screens

| View | Description |
| --- | --- |
| Graph | Nodes are materials; dashed nodes and edges are pending operations |
| Pending panel | Select, discard, undo, or approve staged materials and links |
| Timeline and calendar | Plan lesson stacks while seeing dates and school events |

---

## 7. Repository structure

Public **lesson-preparing-graph** contains the MCP stack only (built via [`export/README.md`](export/README.md)). Your drills and lesson files stay local or in a private repo.

```
lesson-preparing-graph/
├── mcp/               # Cursor MCP server (main entry for agents)
├── server/            # REST API + storage the MCP calls
├── web/               # Graph, timeline, calendar, HITL review UI
├── prompts/           # Agent skills (explore-the-progression, create-materials, …)
├── scripts/           # dev, embed sidecar, tests, optional seed
├── library/           # Empty skeleton; materials/ & periods/ gitignored when filled
│   ├── materials/     # ← your M*.md (not in public clone)
│   ├── periods/       # ← your dated lessons (not in public clone)
│   └── media_library/
└── export/            # Maintainer: how the GitHub repo is produced
```

---

## 8. License and contact

- **用途**：教育科研与非商业学校备课场景  
- **仓库**：https://github.com/Willie-Liao/lesson-preparing-graph  
- **作者**：Willie Liao · JCID FLAG Football 单元（2026–2027 Fall）

---

*Documentation updated: 2026-10-11*
