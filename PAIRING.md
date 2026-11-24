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
