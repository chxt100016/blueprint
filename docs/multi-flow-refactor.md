# 一个业务服务对应多个业务流程 —— 改动方案

> **状态：已实施。** 本文是设计依据，实现与它一致。
> 实测覆盖：一个 product 锚点带两个流程、两个流程共用两个活动、
> 流程/product 两个方向的哈希传导、活动孤儿检测、流程级与活动级清理清单、
> 澄清三步、lock v3 的迁移报错。

## 1. 问题

当前模型把「业务服务」和「业务流程」压成了同一个对象：

- 一个 product 二级标题锚点 = 一个 `spec/<capability>/<service>/flow.md`
- `validateService` 里有一条硬约束：`锚点被多个业务服务引用` 直接报错

真实业务里一次对外交付常常有多个入口。开户是一次交付，但个人开户与企业开户是两个接口、
两套材料、两条审核路径；支付是一次交付，但扫码支付与代扣支付是两个接口。

现在只能二选一：要么把多个接口塞进同一份 flow.md（流程图与步骤失去单一主线，活动划分被迫扁平化），
要么把每个接口写成一个 product 锚点（product 层被迫按接口粒度切分，人写的自然语言描述被撑碎）。

### 两层的定义

| | 回答的问题 | 判据 |
|---|---|---|
| 业务服务 | 对外交付什么 | 一次完整的对外交付，有自己的终态 |
| 业务流程 | 这次交付从哪个入口走完 | **一个对外接口 = 一个业务流程** |

「流程 = 接口」是这次改动的锚点：接口是客观事实，不靠判断，
划分对不对可以直接核对，也可以由脚本校验（flow.md 必填 `entry`）。

三个反例，都是把不同交付误当成同一服务的多个流程：

- **下单与取消订单** —— 两次交付、两个终态，是两个服务。按业务对象聚合（「凡是跟订单有关的」）
  来划服务是错的，那是领域对象的边界，不是服务的边界。
- **商品提报、审核、发布** —— 三次交付、三个终态、三拨调用方，是三个服务。
  阶段之间只有数据衔接，不是同一次交付的不同入口。
- **发起支付与支付回调** —— 两个服务。回调有自己的调用方（渠道）、自己的终态（支付单状态确定）、
  自己的幂等要求。它与发起支付是串行两段，不是互斥的入口形态。

判断口诀：**同服务的多个流程一定是互斥的**——调用方在它们之间二选一。
个人开户与企业开户二选一，所以是一个服务的两个流程；
没人在「发起支付」和「支付回调」之间二选一，所以是两个服务。

## 2. 目标模型

### 2.1 层级

| 层 | 载体 | 粒度 | 写入者 |
|---|---|---|---|
| 商业能力 capability | `product/<capability>.md` | 业务归属域 | 人 |
| 业务服务 service | product 里的二级标题锚点 | 一次对外交付 | 人 |
| 业务流程 flow | `spec/<capability>/<service>/<flow>.md` | **一个对外接口** | flow skill |
| 业务活动 activity | `spec/<capability>/<service>/<activity>/activity.md` | 一次状态变更 | activity skill |
| 业务动作 | activity.md 里的 `A1 A2 A3` | 一步可判定的操作 | activity skill |
| 领域能力 domain | `domain/<domain>/<name>/domain.md` | 跨服务复用的规则 | domain skill |

**业务服务不新增文档层。** 它仍然只是 product 里的一个锚点 + spec 下的一个目录。
目录里另有一份 `service.md`，但它是**轻文档**，见 §2.5。

**业务活动归属服务，不归属流程。** 同一服务的多个流程共享一个活动池，
个人开户与企业开户共用「建档」「发通知」，各自只在前段的材料校验上不同。
flow.md 因此从「容器」变成「编排」——它列出本流程按顺序用到哪些活动。

### 2.2 目录

```
blueprint/spec/account/open/
  service.md              # 轻文档：服务边界与流程登记，脚本不读不校验
  personal.md             # 业务流程 = POST /accounts/personal
  personal.review.md
  enterprise.md           # 业务流程 = POST /accounts/enterprise
  enterprise.review.md
  verify-identity/        # 业务活动，被 personal 编排
    activity.md
    activity.review.md
  verify-license/         # 业务活动，被 enterprise 编排
    activity.md
  create-account/         # 业务活动，两个流程共用
    activity.md
  notify-result/          # 业务活动，两个流程共用
    activity.md
```

流程是 `.md` 文件，活动是目录，天然区分，不需要 `flow_` 前缀，也不需要 `flows/` 这类保留目录名。
`ls` 一眼看全整个服务：有几个接口、有哪些活动。

### 2.3 id

**第三段是固定的层级标记**，`flow` 或 `activity`：

| 层 | 形式 | 例 | 对应的东西 |
|---|---|---|---|
| capability | `<cap>` | `account` | 账户 |
| service | `<cap>.<svc>` | `account.open` | 开户 |
| flow | `<cap>.<svc>.flow.<name>` | `account.open.flow.personal` | `POST /accounts/personal` |
| activity | `<cap>.<svc>.activity.<name>` | `account.open.activity.verify-identity` | 实名核验 |
| domain | `@<group>.<name>` | `@risk.blacklist` | 黑名单校验 |

标记段解决的是一个真实隐患：flow 与 activity 都挂在 service 下，若共用一个三段命名空间，
`bp status` / `bp read` / `bp delete plan` / lock 键 / review 路径都要先查 repo 才知道是哪一层，
而这些命令在 `validate` 之前就要解析 id ——「不得重名」的校验拦不住这个时间差。
加标记段之后 `idKind` 保持纯函数，重名校验也不再需要。

**id 与路径的映射是固定规则**（路径里不含标记段）：

```
account.open.flow.personal            → spec/account/open/personal.md
account.open.activity.verify-identity → spec/account/open/verify-identity/activity.md
```

代价很小：`resolveScope` 取第 1、2 段，**完全不用改**；`codemapPath` 改一行索引
（活动名从 `[2]` 变 `[3]`，codemap 目录本身不含标记段，仍是
`codemap/<cap>/<svc>/<name>.yaml`）。`depends_on` 的作用域与环检测仍是 service 级，
`scope.mjs`、`code/*` 不动。

### 2.4 lock.json（version 3 → 4）

```jsonc
{
  "version": 4,
  "flows": {
    "account.open.flow.personal": {
      "product_anchor": "account#开户",
      "flow": { "product_hash": "…", "flow_hash": "…", "approved_at": "…" }
    },
    "account.open.flow.enterprise": { }
  },
  "services": {
    "account.open": {
      // 只剩活动层的章：flow 层的章移到 flows 段
      "activity": { "flows_hash": "…", "approved_at": "…" }
    }
  },
  "activities": {
    "account.open.activity.verify-identity": {
      "spec": { "service": "account.open", "activity_hash": "…", "approved_at": "…" },
      "impl": { "activity_hash": "…", "files": [], "verified_at": "…" }
    }
  },
  "domains": { }
}
```

`flows_hash` = 该服务下所有 flow 的 hash 按 slug 排序后拼接再哈希。
活动层的上游是「本服务的全部流程」，任一流程变更都要求活动层复核。

### 2.5 service.md 是轻文档

**不参与脚本的任何判定**：不校验、不哈希、不盖章、不产生 stage、不进 lock。
它只做两件事：写清这个服务的边界（做什么、不做什么、关键术语），
汇总登记本服务有哪些流程、有哪些活动。

它在脚本里唯一的接触点是 `bp scope` ——把它加进 flow / activity / code skill 的读取清单，
让它真正作为服务级上下文被用到。由 flow skill 顺手维护。

代价是它可能与实际情况不同步（登记表漏了新流程）。接受这个代价：
它是知识传承，不是契约。**契约由 flow.md 与 activity.md 承担，那两个是硬校验的。**

### 2.6 哈希传导

```
product 锚点 → 各 flow.md（每个流程独立跟进）→ 本服务全部 activity.md → 代码
```

每个 flow.md 各自声明 `product` 锚点并各自存 `product_hash`，
所以 product 一改，该锚点下所有流程都进入 `todo`。
去掉现有的「一个锚点至多被一个 flow 引用」硬约束，改成
**一个 product 锚点至多对应一个 service 目录**（同锚点的流程必须放在一起，否则活动无法共用）。

## 3. 关键取舍

### 3.1 服务层不设确认门，确认门保持三道

服务层不新增 approve、不新增 stage、不新增 skill。人的三道确认门原样保留：

```
bp flow changes|approve <flow>        # 单个流程 + 它的活动编排
bp activity changes|approve <service> # 该服务的全部活动（参数不变）
bp domain changes|approve <@id>       # 不变
```

放弃的东西：没有权威清单声明「这个服务应该有哪几个流程」，
所以脚本查不出「少了一个流程」。脚本只保证**锚点至少有一个流程**（现有 `unclaimedAnchors` 机制），
够不够由 AI 读 product 时判断、由人在流程层确认门把关。

这是划得来的：流程数量少、人一眼看得全，不像活动那样需要清单兜底。

### 3.2 活动自描述，不与流程耦合

**活动是最小业务单元，它的文档只说自己是谁**，不提「我在哪个流程里被怎么用」。
现在活动的一句话说明由 flow.md 的「活动划分」持有
（activity.md 模板特意注明「没有 summary」），这条要反转：
**说明移进 activity.md 的 front-matter `summary`**，由活动自己持有。

由此得到一条拆分规则：**同一个活动在两个流程里含义不同，说明它该拆成两个活动。**
但拆分的维度必须落在活动自己的判据上——**状态变更是否不同**，不是别的：

| 差异在哪 | 处理 |
|---|---|
| 状态变更不同（跨境订单要写海关字段、预占额度） | **拆成两个活动**，`create-cross-border-order` / `create-domestic-order`，各自自描述 |
| 状态变更相同，只是对外错误码不同 | **同一个活动**。它只返回领域错误，映射成哪个对外错误码是接口的事，归 flow 层（§3.3） |
| 状态变更相同，只是入参来源不同 | **同一个活动**。取数是调用方的事 |

不要把「错误响应」提成独立活动。它没有状态变更，按判据它是业务动作（`A1 A2`）或接口契约，
提成活动会让活动层混进非状态变更的东西，判据就失效了。

### 3.3 接口契约整体从 activity 上移到 flow

现在 `entry.api` 挂在 activity 上，`internal` 表示仅被同服务活动调用。
活动被多个流程共用之后，它不可能再持有单一的对外接口。

**把 `entry` 移到 flow.md 的 front-matter**：一个流程一个接口，接口天然是流程的属性。
这同时让「流程 = 接口」从文档约定变成硬校验——flow.md 必填 `entry`，多一个少一个都报错。

`entry` 上移之后，**对外的请求/响应/错误码也要跟着上移**，flow.md 新增「接口契约」章节。
两层契约的分工：

| | 承诺给谁 | 写在哪 |
|---|---|---|
| 接口契约 | 调用方、前端 | flow.md「接口契约」：请求参数、成功响应、对外错误码 |
| 活动契约 | 实现者 | activity.md「输入输出」：活动入参出参、领域错误 |

这正是 §3.2 那张表第二行的落点：同一个「生成订单」活动，跨境流程与普通流程
把它的领域错误映射成不同的对外错误码，差异全在接口契约这一侧，活动不用拆。

activity.md 去掉 `entry` 字段，模板的 `entryFields` 校验移到 flow 模板。
flow.md 的「接口契约」只写对外可见的部分，不重复活动的内部字段。

### 3.4 引用关系正向存放：flow 列出 activity

**flow.md 持有它编排的活动列表，activity.md 不写自己被哪些流程使用。**
反向关系由脚本从正向引用反推，`bp status <activity>` 与 `bp activity changes` 负责告诉人和 AI。

理由按重要性排：

1. **单一写入者**。activity.md 由 activity skill 写。反向存放的话，flow skill 新增一个流程时
   要去改一堆 activity.md，跨了写入者边界——这是整套架构最硬的一条约束。
2. **编排是有序的**。流程里的活动按顺序排列，顺序是流程的信息；
   活动里写「我被谁用」表达不了顺序。
3. **与现有 domain 机制同构**。`activity.uses → domain` 正向写，`domain.usedBy` 由脚本反推。
   活动引用照搬这个形状，`repo` 里加一个反查表即可，零新概念。

反向存放的具体坏处：删一个流程要改 N 个 activity.md，漏一个就产生孤儿引用。

一个活动被多个流程编排之后，改它会同时影响多个接口。
`bp activity changes` 的输出要给每个活动标注**被哪些流程使用**，
人在确认门上才看得到影响面。这是活动共享后必须补的一条信息。

## 4. stage 与状态

**层级不变**：`LAYERS = ['flow', 'activity', 'domain', 'code']`，
stage 顺序不变，不新增 skill，pipeline 的分派表不变。

**`scanFlow` 改为遍历流程**（原来遍历服务）：

| 条件 | state |
|---|---|
| product 锚点 hash 变了、flow.md 没变 | `todo` |
| 有变更且澄清未结清 | `review` |
| 有变更且澄清结清 | `approve` |
| 都没变 | `done` |

行 id 从 `account.open` 变成 `account.open.flow.personal`。未认领锚点的处理原样保留。

**`scanActivity` 仍按服务聚合**，只有两处变化：

- 门槛从「该服务已 flow approve」变成「该服务下**所有流程**都已 flow approve」
- 上游哈希从单个 `flow_hash` 变成 `flows_hash`（§2.4）
- 活动清单从单份 flow.md 的「活动划分」变成**所有流程「活动编排」的并集**

**`scanOrphans`** 改两条：

- flow.md 声明的锚点不存在 → `orphaned`（原来挂在 service 上）
- 活动目录不被本服务任何流程编排 → `orphaned`（原来是「不在活动划分中」）

**`scanCode`、`scanDomain` 完全不变。**

## 5. 逐文件改动清单

### 5.1 lib/

| 文件 | 改动 | 量 |
|---|---|---|
| `repo.mjs` | service 目录下扫 `.md` 文件为 flows（跳过 `service.md` 与 `*.review.md`）、扫子目录为 activities；新增 `repo.flows`；`service.activityList` 改为所有流程编排的并集；新增 `activityUsers` 反查表（活动 id → 编排它的流程列表，与现有 `domainUses` 同构，见 §3.4）；`anchorUsers` 由 flow 收集但允许多个（同目录）；`LOCK_VERSION = 4` | 中 |
| `schema.mjs` | 原 `validateService` 拆成 `validateFlow`（每个流程：章节、`entry` 必填、锚点存在、活动编排 slug 合法）+ 服务级检查（活动目录 ↔ 编排并集、同锚点同目录）；`validateActivity` 加 `summary` 必填、去掉 `entry`、`depends_on` 段数与标记段 | 中 |
| `stage.mjs` | 见 §4；新增 `flowsHash(service)` | 中 |
| `config.mjs` | `idKind` 改为读第 3 段的标记（仍是纯函数，且比现在更可靠）；新增 `idToPath` 映射；`resolveScope` **不动** | 小 |
| `codemap.mjs` | `codemapPath` 活动名索引 `[2]` → `[3]` | 一行 |
| `db.mjs`、`hash.mjs`、`review.mjs`、`parse.mjs` | **不动** | — |

### 5.2 commands/

| 文件 | 改动 | 量 |
|---|---|---|
| `flow/changes.mjs`、`flow/approve.mjs` | 参数从 service id 变 flow id；approve 写 `lock.flows[id]` | 中 |
| `activity/changes.mjs` | 参数不变；活动清单改取编排并集；每个活动加「被哪些流程使用」（§3.4） | 小 |
| `activity/approve.mjs` | 参数不变；门槛改为所有流程已 approve；写 `flows_hash` | 小 |
| `status.mjs` | service 视图列出流程；新增 flow 视图 | 小 |
| `scan.mjs` | `scanProduct` 输出锚点 → 各流程 | 小 |
| `delete/plan.mjs` | 增加 flow 分支（删一个流程 = 删一个 `.md` + 它独占的活动） | 小 |
| `commit/shared.mjs` | flow 路径正则 `<cap>/<svc>/flow.md` → `<cap>/<svc>/<flow>.md`（注意排除 `service.md`） | 小 |
| `scope.mjs` | 活动的读取清单里，`flow.md#流程` 改为「编排了本活动的所有流程」；加入 `service.md` | 小 |
| `read.mjs` | flow id 走 `repo.flows` | 小 |
| `code/*`、`domain/*`、`schema/*`、`which.mjs`、`verify.mjs` | **不动** | — |

### 5.3 runtime/

`entities.mjs` 新增 `flowOrDie`；`reviews.mjs` 的 `reviewPathFor` 加 flow 分支
（`<flow>.review.md` 与 flow 文件同层）。

### 5.4 templates/{backend,fullstack}/

`flow.md` front-matter：

```yaml
flow:     # 业务流程 id，形如 <capability>.<service>.<flow>，与文件路径一致
title:    # 业务流程的中文名
product:  # product 锚点，形如 <capability>#<二级标题>；同锚点的流程必须在同一个 service 目录下
entry:
  api:    # 本流程对外暴露的唯一接口，如 POST /accounts/personal
```

章节改动：

- 「活动划分」改名**「活动编排」**，留在正文而不进 front-matter ——
  它需要表达顺序与条件（「校验失败时跳过后续」），正文比 YAML 数组能承载的多。
  格式沿用 `- <slug>  <在本流程中的作用>`，`parseActivityList` 直接复用。
  新增的活动与复用其他流程的活动都要列出，脚本从这里反推「活动被哪些流程编排」。
- 新增**「接口契约」**章节：请求参数、成功响应、对外错误码（§3.3）。

`activity.md`：front-matter 加 `summary`（一句话说明，由活动自己持有），去掉 `entry`。
「输入输出」章节的语义收窄为活动自己的入参出参与领域错误，
对外错误码不写在这里——那是接口契约的事。

新增 `service.md` 模板（轻文档，不进校验体系）：

```markdown
---
service:   # <capability>.<service>
title:
product:   # <capability>#<二级标题>
---

## 服务边界
（这个服务对外交付什么、终态是什么、明确不做什么、关键业务术语。）

## 上下游服务
（本服务由哪个服务的终态触发、完成后触发哪个服务。例如支付回调服务的上游是发起支付服务。
只是知识记录，脚本不校验；将来做服务编排能力时从这里升级。无则写「无」。）

## 流程登记
（本服务有哪些接口，每个接口一行：`- <flow-slug>  <接口>  <由谁调用>`。）

## 活动登记
（本服务的活动池，每个一行：`- <activity-slug>  <被哪些流程编排>`。）
```

`product.md`：补锚点粒度指引 —— 一个二级标题写一次完整的对外交付。
「商品提报」「商品审核」「商品发布」是三个标题，「发起支付」与「支付回调」是两个标题，都不要合并；
同一次交付的多个入口形态（个人开户 / 企业开户）写在同一个标题里，拆成几个接口是 flow skill 的事。
判断方法：**调用方会不会二选一**——会，就写一个标题；不会，就是两个标题。

### 5.5 skills/

| 文件 | 改动 |
|---|---|
| `flow.md` | 划分判据改为「一个对外接口一个流程」（见下）；「活动划分」改「活动编排」，新增复用规则；产出对象从服务变流程，逐个流程推进；顺手维护 service.md |
| `activity.md` | 活动清单改取编排并集；新增 summary；去掉 entry；强调**改共用活动要看影响面** |
| `domain.md` | 复用判据单位从「业务服务」→ 保持不变（见 §6.1） |
| `code.md`、`commit.md`、`pipeline.md` | 措辞里的「业务服务」按语境改「业务流程」；分派表不变 |

**流程划分判据**（写进 flow skill）：

> **一个对外接口 = 一个业务流程。** 数几个接口就划几个流程，不用判断步骤是否重合。
> 「对外接口」指外部可独立触发的入口：HTTP / RPC 接口、消息消费入口、定时任务入口、异步回调入口。
>
> 同一个服务下出现多个流程，只有一种成立的情形：**同一次交付有多个入口形态，且调用方二选一** ——
> 个人开户与企业开户、扫码支付与代扣支付、C 端下单与后台代客下单。
> **不互斥就不是同一个服务的流程。**
>
> 三种不要拆的情况：
>
> - **交付目标不同、终态不同 → 那是两个服务。** 下单与取消订单是两个服务；
>   商品提报、审核、发布是三个服务；发起支付与支付回调是两个服务。
>   串行的阶段之间只有数据衔接，不是同一次交付的不同入口。
> - **同一个接口内部按参数走分支 → 那是同一流程内的分支**，写进「分支与异常」。
>   `POST /accounts` 靠 `type` 区分个人/企业时是一个流程；
>   拆成 `/accounts/personal` 与 `/accounts/enterprise` 才是两个流程。
> - **只是步骤多 → 那是活动编排该解决的**，不是流程划分。
>
> 参考值：每个业务服务 1~3 个流程，只有一个流程是常态。

**活动复用规则**（写进 flow skill 的编排环节）：

> 编排前先看本服务已有哪些活动（`service.md` 的活动登记 + 目录）。
> **能复用的一律复用，不要为本流程新建一个只是名字不同的活动。**
> 判断标准是活动自己的判据——单独完成后业务对象发生了什么状态变更——**与哪个流程调用它无关**。
>
> 复用与拆分的分界（详见 §3.2）：
>
> - 状态变更不同 → 两个活动，分别起名，不要硬合并成一个带分支的活动
> - 状态变更相同、只是对外错误码不同 → 同一个活动，差异写进各流程的「接口契约」
> - 状态变更相同、只是入参来源不同 → 同一个活动
>
> **活动文档里不许出现「在 X 流程中……」这类话。** 活动只描述自己是谁；
> 它被谁编排、在编排里排第几，由 flow.md 和脚本的反查表回答。

## 6. 风险与遗留问题

1. **domain 的复用判据保持不变**（「被两个以上业务服务引用」）。
   活动可以跨流程共用之后，同服务内的复用有了 `depends_on` 与共享活动两条通道，
   不需要把领域层的判据往下挪。这是活动归属服务带来的又一个简化。

2. **`depends_on` 作用域保持「同服务内」**，环检测与拓扑排序作用域保持 service。
   **完全不用改。**

3. **共用活动的变更影响面**。改一个被三个流程编排的活动，三个接口的行为都会变。
   靠 §3.4 的影响面提示 + 人在活动确认门把关。脚本不阻止，也不该阻止。

4. **服务之间的串行关系目前无处表达**（已定：回调是独立服务，见 §1）。
   发起支付 → 支付回调、提报 → 审核 → 发布，这些关系现在只能靠 product 的自然语言承载。

   **本次不做服务编排能力**，但留一个零成本落点：在 `service.md` 里登记上下游服务。
   它本来就不参与脚本判定，写上下游不增加任何成本，人和 AI 都读得到。
   等确实需要脚本能力（跨服务的状态传导、编排校验）时，再把它升级成正式的一层，
   届时 service.md 从轻文档变成契约文档即可，目录结构不用动。

5. **`bp scan flow` 的行数会变多**（从服务数变成接口数），
   `bp stage` 的输出更细。这是好事，但 README 里的示例输出要更新。

6. **`docs/bp-script-analysis/` 的 SVG** 中，
   `01-runtime-architecture`、`04-object-state-machines`、`05-hash-lock-propagation`
   涉及 spec 目录结构与 lock 结构，需要重画；其余基本可用。

## 7. 迁移

`lock.json` v3 → v4。改动比原设想小：活动 id 不变，`activities` 段原样保留（只是 `spec.service` 语义不变）。

需要动的只有：`services[id].flow` 移到 `flows[id.<flow-slug>]`、
`services[id].activity.flow_hash` 改名 `flows_hash`。

人工步骤（写进 `loadLock` 检测到旧版本时的报错文案）：

```
# 1. flow.md 改名为 <flow-slug>.md，并从活动目录的父级移出来（原本就在同级，无需移动）
mv blueprint/spec/account/open/flow.md blueprint/spec/account/open/create.md

# 2. 补 front-matter 的 entry（从原 activity.md 的 entry.api 里搬），删掉 activity.md 的 entry
# 3. 活动的一句话说明从 flow.md 的活动划分搬进各 activity.md 的 summary
# 4. lock.json：services.<id>.flow → flows.<id>.<flow-slug>.flow，activity.flow_hash → flows_hash
# 5. 重新走一遍 flow approve 与 activity approve（front-matter 变了，哈希必然失效）
```

同样建议不写自动迁移脚本，与母版「靠重跑 init 刷新生成物，不另设 upgrade」的取向一致。

## 8. 实施顺序

1. **数据模型**：`repo.mjs`（扫 `.md` 为 flows）+ lock v4。命令暂不动，保证加载不报错。
2. **校验与状态**：`schema.mjs`、`stage.mjs`。跑 `bp scan` 验证四层状态推导。
3. **命令层**：`flow/*`、`activity/*`、`status`、`delete/plan`、`commit/shared`、`scope`。
4. **模板与文档**：templates、skills、WORKFLOW、README、SVG。

相比「活动归属流程」的方案，`config.mjs`、`codemap.mjs`、`scope.mjs`、`code/*`
这一整片不用动，改动量大约少掉一半。第 1、2 批仍是主要工作量。
