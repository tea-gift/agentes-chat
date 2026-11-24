# Pairing codes（配对码）— 基于 surface bridge（ADR 0187）

## 现状：配对码已经有了，不用另起一套

Surface bridge（ADR 0187）就是 Pachat 式配对码接入，流程已经跑通：

1. app 里生成 8 位码（10 分钟，`POST /organizations/{orgId}/surface-link/code`）
2. 外部服务凭码认领（`POST /api/surface/v1/links/claim`）
3. 用户在 app 里确认 → 链接生效
4. 消息走 `POST /api/surface/v1/messages` 进，`GET /api/surface/v1/deliveries` 取回复

开 bridge 靠三个环境变量：`SURFACE_BRIDGE_TOKEN`（≥32 字符，与 operator token
不同）+ `SURFACE_NAME` + `SURFACE_OPEN_URL`；路由在 operator listener（3001 端口，
不对外），服务在外、服务器不主动调它。

代码位置：`packages/engine/src/surfaces/`（`links.ts` 码/认领/确认/断开、
`inbound.ts` 消息进、`deliveries.ts` 回复出、`turn.ts` surface 回合的工具限制、
`config.ts`）；`apps/server/src/surface/app.ts`（bridge 的 HTTP API）；
`apps/server/src/routes/app/surfaces.ts`（app 侧路由）；表在
`packages/db/src/schema/surfaces.ts`（`surface_links`、`surface_deliveries`、
`surface_calls`）；web UI 在 `apps/web/src/components/SurfaceLink.tsx`
（Settings › Notifications › Where they arrive）。

## 要改的两点（dev 分支这期只做这两点）

1. **现在 bridge 只连内置助手 right_hand**（也就是 doubao1）：消息固定发到与
   right_hand 的 DM，回复只认 right_hand 发的消息。mu1 这类 agent 连不上。
2. **一人只能有一条 active 链接**（`surface_links_one_per_account` 唯一索引；
   confirm 时删掉该账号的旧链接；UI 也是单行）。想同时连豆包、Workbuddy、Muse
   就得多条。

目标：在列表里加外部 AI 连接（豆包、Workbuddy、Muse 等），每条连接是一条
surface link，显示对方身份（display / profileName）+ 目标 agent + 状态，可断开；
链接能指定连到某个 agent，不选 = 默认 right_hand（现有行为不变）。

## 设计

### 数据：`surface_links.agent_id`（新列，可空；NULL = right_hand）

- 迁移：`ALTER TABLE surface_links ADD COLUMN agent_id uuid`（可空、无默认值，
  deploy-safe）。索引：`surface_links_one_per_account` 从
  `(user_id, surface)` 改成 `(user_id, surface, coalesce(agent_id, 零 UUID))`，
  即一人每个 agent 一条 active 链接；同一 sender 仍只能有一条 active（现有
  `surface_links_one_per_sender` 索引保留）。迁移要过 `bun run check:migrations`，
  DROP 旧索引那行按规则加 `-- deploy-safe:` 注释并写明原因（只放宽约束）。
- `surface_deliveries`、`surface_calls` 不动（`link_id` 本来就是 per-link）。

### Engine（`packages/engine/src/surfaces/`）

**`links.ts`**

- `mintLinkCode(db, userId, orgId, agentId?)`：agentId 可空；校验 agent 存在于
  该 org、未归档、不是 right_hand（right_hand 用默认，不必指定）；校验该 agent
  能跟这个人说话（`canTalkTo` + `speakerFor`，与 `lodiFor` 同款规则）。把
  agentId 写进 verification 的 value（`{ userId, orgId, agentId }`）。
- `claimLink`：pending link 带上 agentId。
- `confirmLink`：校验 agent 仍可说话；新规则：只替换同一人、同一个 agent 的
  旧 active 链接（原来是删掉该账号全部 active 链接）；同 sender 的 active
  链接仍只能有一条（`surface.taken` 检查 + 唯一索引兜底）。
- `SurfaceLinkView` + `viewsOf`：加 `agentId` + `agentName`（join agents 表）。
- 新增 `agentForLink(db, link)`：解析链接的目标 agent（agentId 有值取它，
  否则取该 org 的 right_hand），含“能跟这个人说话”校验，inbound 和 deliveries
  共用。

**`inbound.ts`（`postFromSurface`）**

- 不用 `lodiFor`，改用 link 的目标 agent：`agentForLink` →
  `openPersonAgentDm(db, orgId, userId, agent.id)`；其余不变（限流、voice、
  `via`、`clientId`、去重）。错误码 `surface.no_assistant` 含义不变。

**`deliveries.ts`**

- `queueSurfaceDelivery`：门改成“消息作者 == 链接的目标 agent（agentId 有值
  比它，空比 right_hand），且 channel 是 DM”。关键：用 `surfaceOfRun` 给出
  的 `linkId` 去取 link（现在代码用 `activeLinkOf(userId)` 取账号的唯一链接；
  多链接后必须按 `linkId` 取，新增一个按 id 查 link 的查询）。
- `tellSurfaceVoiceDropped`：按 `linkId` 取 link，通知改由目标 agent 发
  （`postFromLodi` 的 `lodi` 参数可传任意 Agent）。

**`turn.ts`：不用改。** `surfaceRefusal` 按 link 走（`surfaceOfRun`），与
agent 无关；工具限制对 agent 回合同样适用（安全默认）。

### 路由（`apps/server`）

- app 路由 `routes/app/surfaces.ts`：mint 的 body 加 `{ agentId?: uuid }`；
  `SurfaceLink` schema 加 `agentId` + `agentName`（可空）。其余不变。
- bridge 路由 `surface/app.ts`：不用改（claim / messages / deliveries 都是
  link 驱动的）；只把 `POST /messages` 摘要里“DM with the workspace's right
  hand”的文案改成目标 agent 的说法。
- OpenAPI 变了 → 重新生成 `apps/server/test/surface-openapi.json`
  （`surface-bridge.test.ts` 会拿它当已提交的合约校验）。

### 客户端与 UI

- `packages/client`：`SurfaceLink` 类型加 `agentId` / `agentName`；
  `surfaces.mintCode(orgId, agentId?)`。
- `apps/web/src/components/SurfaceLink.tsx`：
  - 列表：`surfaceRowOf` 的单行假设改成列出该账号的全部链接（每条：对方身份
    + 目标 agent 名 + 状态 + Unlink）。`packages/client/src/lib/surface-links.ts`
    新增 `surfaceLinksOf` 返回列表（`surfaceRowOf` 原样保留，mobile 还在用）。
  - 发码 dialog：加选 agent（默认“内置助手”即 right_hand；下拉列出该工作区
    能说话的 agent，复用现有的 `useAgents`）。
  - i18n：新字符串 en + pt-BR。
- 注意：mint 时选的 agent 是“回答这个连接的 agent”；确认后不可改（改 = 删了重连）。

### 不做的（v1 之外）

- 不做多 surface：一个服务器仍只桥一个 `SURFACE_NAME`；豆包 / Workbuddy /
  Muse 是同一 bridge 下的不同 sender / 链接（各自由外部服务认领）。
- 不给链接改名 / label：显示对方上报的 display / profileName。
- 不做“外部 AI 不经 bridge 直接当 brain”的新协议。
- 不动 3001 端口的对外发布（ops 另说）。

### 安全注意（沿用 ADR 0187 的）

- 码 10 分钟、一次使用（认领时原子删除）；错码 / 用过 / 过期一律同个错。
- 链接只进目标 agent 的 DM，不进其他会话；bridge token 泄露仍只能动已链接的
  人自己的 DM，不能登录、读其他会话、到 operator API。
- surface 回合的工具限制不变（卡片、审批、发/删/付、角色预算账单、跨 agent
  例程等一律拒绝）。

### 测试

- engine：`surfaces-links.test.ts` 加 mint / confirm 带 agent 的用例（agent
  不存在、已归档 → `surface.no_assistant`；confirm 只替换同 agent 旧链、
  不同 agent 的链共存；confirm 时仍按链接的目标 agent 重新校验）；
  `surfaces-inbound.test.ts` 加目标 agent 的消息进其 DM 的用例；
  `surfaces-deliveries.test.ts` 加目标 agent 回复成 delivery、非目标 agent
  不成 delivery 的用例。
- server：`surface-links.test.ts` 加 mint 带 agentId 的路由用例（未知 agent
  → `surface.no_assistant`，right_hand 的 id 归一为默认）；
  `surface-bridge.test.ts`（OpenAPI 合约更新）。

### 上线（ops，另行，不在这期代码里）

- bridge 本身要在运行实例上开：`~/agentes/.env` 加 `SURFACE_BRIDGE_TOKEN`
  （≥32 字符，与 operator token 不同）+ `SURFACE_NAME` + `SURFACE_OPEN_URL`，
  重启 agentes 容器；3001 只在内网，外部 bridge 服务要能连到它（跑同一台机器
  或内网）。

---

# Muse as brain（dev 分支，ntfy 频道就是连接）

一个 agent 可以让外面一个 Muse 当它的脑子：有人给它发 DM，它的回复由那个 Muse
来写，而不是自己的模型。连接就是 ntfy 服务器 + topic 名——跟 ntfy 本身一样：
POST 到 topic 就是发，GET 轮询 topic 就是收。**没有认领码，topic 名本身就是共享
密钥。** 壳是 bridge（配对、投递、把回复以 agent 的名义发出去），传输是 ntfy；
不另起一套传输，不做同步 HTTP（不等 Muse 的回复超时）。

## 连接：`POST /me/surface-links/ntfy-brain`

Body `{ agentId, server, topic }`。server 必须是 http(s) URL，topic 是
`[-A-Za-z0-9_]{1,64}`。链接**立刻生效**（没有确认步），surface 记为 `ntfy`，
externalId/display = topic，`brain: true`。建链接时：

- 替换同一人、同一 agent 的旧 ntfy 链接（一个 surface 一个 agent 一条 active 链接）；
- 抹掉该 agent 在其他 surface 上的 brain 标记（一个 agent 只能有一个 brain）。
- 校验：agent 存在（`surface.brain_no_agent`，404）、在调用者的工作区里
  （`surface.brain_not_member`，403）；server/topic 不合法是 400
  （`surface.brain_bad_server` / `surface.brain_bad_topic`）。
- 仍需 bridge 已配置（`surfaceOn()` 门；未配 → `surface.off`，404）。

UI：Settings › Notifications › Where they arrive 里多一行 "Connect a Muse as
brain"，弹框选 agent、填 server 和 topic，Connect 即建；brain 链接在列表里单独
显示（ntfy + topic + Unlink）。i18n en + pt-BR。

## 请求：引擎 POST 到 topic

DM 的 run 的 brain 解析到 `surface` 时（`packages/engine/src/surfaces/brain.ts`）：

1. `queueSurfaceBrainRequest` 先 POST 再记账：生成 delivery id → POST 到
   `{server}/{topic}`，标题 `[brain-request <deliveryId>]`，正文是 DM 最近 12 条
   消息（上限 3500 字符）→ 再插 `surface_deliveries` 行（kind `brain_request`，
   带 `runId`）+ 60 分钟后唤醒 run 的 fallback job。POST 失败或链接没 topic
   → 返回 null，run 失败 `surface_brain_unreachable`。
2. run 停在 `waiting_input` 等回复。`surface_deliveries` 的那行就是待处理请求的
   记录和超时锚；**relay 不轮询 `/deliveries` 找 brain 请求**（那里不列它们，
   `listSurfaceDeliveries` 排除了 `brain_request`）。

## 回复：relay 转、服务器轮询 topic

- relay（`~/workspace/muse-relay/relay.py`，`BRAIN_TOPICS` 环境变量，JSON 数组，
  每建一个 brain link 加一项 `{"server", "topic"}`）：每 25 秒 GET
  `{server}/{topic}/json?poll=1&since=…`，读到 `[brain-request <id>]` 就记下
  `id → {server, topic}`（`state.json` 的 `brain_pending`），把请求原样发到
  Ch1（标题不变）交给 Muse；Muse 在 Ch1 回 `[brain-reply <id>]`，relay 按
  pending 表 POST 回原 topic。没记下的 id 的回复直接丢弃。
- 服务器 `surfaceBrainPoll` worker 每 30 秒轮询每个 brain topic
  （`pollSurfaceBrainTopics`，首次回溯 5 分钟，之后按最后一条消息 id），读到
  `[brain-reply <id>]` 就 `answerSurfaceBrainRequest`：把回复存进 run 的
  transcript（`surfaceBrainReply`），把 delivery 关掉（`taken_at`，outcome
  `sent`），run 重新入队。收到回复的 worker 还会踢一下 outbox。

## Run 的结局（executor 的 surface-brain 分支）

- 有存好的回复 → 以 agent 的名义把 Muse 的话发出去，run 完成（done）。
- 没链接 → 失败 `surface_brain_unlinked`。
- 请求还开着 → 重新挂起（等回复或超时）。
- 请求已关（超时 60 分钟，fallback job 唤醒）→ 失败 `surface.brain_timeout`。
- 队列返回 null（没 topic / POST 失败）→ 失败 `surface_brain_unreachable`。

## 范围

- 只接 **DM** 的 run、**人**触发的、**非保密**会话（ADR 0190）。例程 / 任务 /
  后台 run 永远不用 surface brain。
- Brain kind `"surface"` 是 `BrainKind`，但**不是** `ComputerBrainKind`（没机器 /
  计划 / 账号），也**不是**存下来的 brain：agent 存的 brain 仍是 `"model"`；
  brain 的切换在链接上，不在 brain 选择器里。

## 已知的缺口（按设计，待后续）

- 超时 / 断链是让 run 失败，**不在 DM 里贴一条通知**（要一个 i18n bodyCode，
  后续再做）。
- brain topic 必须在 tearoad-os 能连到的服务器上：tearoad-os 连不上阿里云
  ntfy（Ch2，TLS 握手超时），Ch1（InstaBox ntfy）能通。

## 代码位置

- 迁移：`packages/db` 0326 `surface_brain`（`surface_links.brain` + 每个
  (user, surface, agent) 一个 brain 的唯一索引；deliveries kind `brain_request`
  + `run_id`）、0327 `surface_brain_ntfy`（`ntfy_server`、`ntfy_topic`）。
- 引擎：`packages/engine/src/surfaces/brain.ts`（建链、找链、排队、应答、轮询）、
  `packages/engine/src/executor.ts`（surface-brain 分支）、
  `packages/engine/src/surfaces/deliveries.ts`（brain 请求不进列表）、
  `packages/engine/src/brains/types.ts` + `brain-settings.ts` 等（`surface`
  不进 `StoredBrainKind` / `ComputerBrainKind`）。
- 服务器：`apps/server/src/routes/app/surfaces.ts`（ntfy-brain 路由）、
  `apps/server/src/workers.ts`（`surfaceBrainPoll` 每 30 秒）。
- 客户端 / web：`packages/client`（`createNtfyBrain`）、
  `apps/web/src/components/SurfaceLink.tsx`（brain 弹框 + 列表）。
- 中转：`~/workspace/muse-relay/relay.py`（`BRAIN_TOPICS`、brain 请求 / 回复
  的转发、pending 表）+ README。
- 测试：`packages/engine/test/surfaces-brain.test.ts`（12）、
  `apps/server/test/surface-links.test.ts`（ntfy-brain 路由 1 个）。

## 上线（ops，另行，不在这期代码里）

- dev 镜像要重建 + 重启 tearoad-os 上的 agentes（运行实例现在是官方镜像，
  dev 的改动不生效）；relay 也要更新并在 `~/muse-relay/.env` 里加
  `BRAIN_TOPICS`（每建一个 brain link 加一项），再 `docker compose up -d --build`。
- 哪个外面的 Muse 当 brain（用户自己的另一个 Muse，还是别人的）尚未确认，
  上线前要定下来。
