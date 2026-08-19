---
name: blueprint
description: 仅在用户明确要求「初始化 blueprint」或「刷新 blueprint 生成物」时使用。不参与日常流水线——日常推进用 pipeline-<project> skill。
license: MIT
compatibility: 需要 Node.js 18+（脚本零 npm 依赖，只用内置模块）；bp snapshot pull db 另需系统自带的 pg_dump / mysqldump / sqlite3
metadata:
  version: "1.0.0"
  author: chxt100016
---

# blueprint

规范驱动的开发流水线：人用自然语言描述业务需求，AI 逐层细化为标准流程与业务活动，
人在每层确认后 AI 实现代码，脚本负责一切确定性判断。

**本 skill 只做一件事：init。低频、影响面大，不应被日常流水线意外命中。**
日常推进用生成出来的 `pipeline-<project>` skill。

`init` 是幂等的：生成物无条件覆盖，定制物已存在则原样保留。母版迭代期直接重跑 init
就能把新的 `scripts/` `templates/` 与七个 skill 刷进项目，因此不另设 upgrade 命令。

## 定位母版

以下用 `SKILL_DIR` 代指本 SKILL.md **实际所在目录**，`BOOTSTRAP` 代指 `$SKILL_DIR/bootstrap.mjs`。
`BOOTSTRAP` 是独立的单文件安装器，只读取旁边 `assets/` 中的母版资产，不复用也不进入项目内的 `blueprint/scripts/`。

具体路径取决于装法：手动拷贝就是 `.claude/skills/blueprint/` 或 `~/.claude/skills/blueprint/`；
用 `npx skills add` 装的话，母本通常在 `~/.agents/skills/blueprint/`，
再由 `~/.claude/skills/blueprint` 软链暴露——两条路径都能直接 `node` 运行，
Node 会把软链解析成真实路径。不确定时先 `ls $SKILL_DIR/bootstrap.mjs` 确认。

初始化或刷新必须用 `BOOTSTRAP` 运行；`BP` 只指项目内的 `node blueprint/scripts/bp.mjs`，
不再承担母版安装职责。

---

## init

### 1. 询问并确认

逐项问清楚，不要替用户猜。每项都给出建议值，让用户确认或改：

| 项 | 说明 | 建议值 |
|---|---|---|
| 项目名 | 会变成七个 skill 的后缀，如 `pipeline-shop`、`ui-shop` | 取仓库目录名 |
| 代码布局 | `layout.app` / `layout.domain` 的模板串 | 先扫一眼现有目录结构再建议 |
| 编译命令 | `verify.app` | 从 package.json 的 scripts 里找 |

布局模板串支持两组占位符：`{capability}`、`{service}`（业务活动）与 `{name}`（领域模型）。

```
src/modules/{capability}/  →  order.create.apply-coupon  得到  src/modules/order/
src/domain/{name}/         →  @order.order               得到  src/domain/order/
```

`{capability}` 是**商业能力**（`product/<capability>/` 目录），
`{name}` 是**领域模型**的名字（`domain/<领域>/<name>/`），两者分属不同层、词不通用。

### 2. 执行

```
node $SKILL_DIR/bootstrap.mjs \
  --root <项目根> \
  --project <项目名> \
  --layout-app "src/modules/{capability}/" \
  --layout-domain "src/domain/{name}/" \
  --verify-app "npx tsc --noEmit -p tsconfig.server.json"
```

脚本会：拷贝 `scripts/` 与 `templates/`；生成 `config.yaml`、
`context/README.md`、`context/rpc/README.md`、空 `lock.json`；生成七个 `*-<project>` skill
（pipeline / flow / activity / domain / code / commit / ui）；
创建空的 `blueprint/ui/`，由 ui skill 首次使用时与人讨论后建立项目级 UI 上下文；
追加 `.gitignore`（排除 `blueprint/context/db.yaml`，该文件允许写明文凭据）。
**拷贝一律用文件复制，不用模型生成。**

### 3. 收尾提示

告诉用户还需要手动做三件事：

1. 写 `blueprint/context/db.yaml`（不入库）
2. 首次运行 `node blueprint/scripts/bp.mjs snapshot pull db`；
   要让 AI 拿到外部 HTTP 接口的出入参，再往 `blueprint/context/rpc/<商业能力>/` 下贴 curl，
   跑 `bp snapshot pull rpc`（格式见该目录 README）
3. 按本项目实际结构填 `config.always_readable`（共享工具、类型定义那类目录），
   init 不猜这一项，留空则每次 `bp scope` 只给活动自己的目录

然后写第一个业务服务：`blueprint/product/<商业能力>/<业务服务>.md`，一份文件就是一个业务服务，
目录名与文件名都用英文 kebab-case（路径即 id，`product/order/checkout.md` 就是 `order.checkout`），
内容参考 `blueprint/templates/product.md`。写完调用 `pipeline-<project>` 开始。
需要实现界面时，调用 `ui-<project>` 并给出一个已确认的 flow ID。

### 业务对象与路径

| 层 | 路径 | id |
|---|---|---|
| 业务服务 | `product/<cap>/<svc>.md`（人写）+ `spec/<cap>/<svc>/`（产出） | `<cap>.<svc>` |
| 业务流程 | `spec/<cap>/<svc>/<flow>.md` | `<cap>.<svc>.flow.<flow>` |
| 业务活动 | `spec/<cap>/<svc>/<act>/activity.md` | `<cap>.<svc>.activity.<act>` |
| 领域模型 | `domain/<领域>/<name>/domain.md` | `@<领域>.<name>` |

**路径即 id，双向可推。** 文档因此不声明自己属于谁，front-matter 的 `id` 只是与路径比对的冗余；
建文档一律用 `bp new <id>`，路径由脚本算。改名等于删除重建，残留物会作为孤儿告警报出，
用 `bp delete plan <id>` 生成清理清单交人确认。

---

## 刷新生成物

母版改了、想把新版刷进已有项目时，用原来那条 init 命令重跑即可：

```
node $SKILL_DIR/bootstrap.mjs --root <项目根> --project <项目名>
```

生成物覆盖，定制物保留。**`config.yaml` 已存在就完全不动**——母版新增了配置字段的话，
按母版 `assets/config.yaml` 手动补进去。
刷新时会清理旧版生成的 `blueprint/WORKFLOW.md`。

**改了模板或章节结构的话**，已 approve 的文档会因为哈希取材变化而全部进入偏离态，
需要人工把文档改成新结构再重走 approve。当前没有迁移工具，这是刻意留白：
母版稳定之前不值得为它写自动化。

---

## 生成物与定制物

| 路径 | 归属 | 重跑 init |
|---|---|---|
| `.claude/skills/*-<project>/SKILL.md` | 生成物 | 覆盖 |
| `blueprint/scripts/` | 生成物 | 覆盖 |
| `blueprint/templates/` | 生成物,但**是校验真相源** | 覆盖(定制会丢) |
| `blueprint/config.yaml` | 定制物(init 时生成一次) | 不动 |
| `blueprint/ui/` | UI skill 维护的项目上下文 | 不动 |
| `blueprint/product/` `context/` | 定制物(人写的业务描述) | 不动 |
| `blueprint/spec/` `domain/` `codemap/` `lock.json` | 定制物 | 不动 |

### 关于 templates

`blueprint/templates/` 是 schema，不是样板：**正文只有章节标题，一个字都不多**。
章节表与 front-matter 字段白名单由脚本从这些文件解析得到（`config.mjs` 的 `loadTemplateSpec`），
改模板即改章节表，不必动代码。

**每节写什么不写在模板里**，写在对应的 skill 里。模板里的任何东西——填写说明、表头、
HTML 注释——都会跟着骨架落进每一份产出文档，AI 填写时连同内容一起替换掉，
下一轮改这份文档的人再也看不到。例外是 `product.md`——它由人写，
人写的时候不加载任何 skill，说明只能放在模板里。

编号前缀这类附加规则也因此不进模板，写在 `config.mjs` 的 `SECTION_RULES` 里：
哪个章节需要连续编号、用哪个前缀——活动的「业务动作」是 `A`，聚合的「不变量」是 `I`、「命令」是 `C`，
领域服务的「规则」是 `R`。那里的章节名与模板对不上会直接报错，不会静默失效。

**全部章节都参与文档哈希**，没有例外——文档里写下的每一个字都是确认过的内容，改了就该让人重看一遍。

front-matter 的键即允许出现的字段。字段各自的必填与取值规则写在 `schema.mjs` 里，
模板只定白名单——流程的 `type`（`api` / `mq` / `cron`）与 `facade` 是这样一对。

四份模板（flow / activity / domain-aggregate / domain-service）的第一节统一是 `## 概要`：
单行、不超过 40 字，脚本硬校验。
它是各层清单唯一直接列出的正文——`bp scan flow`、`bp scan activity`、`bp domain list` 都靠它，
人和 AI 由此在不打开文件的情况下认出一个对象。**这一节不要移位，也不要改名**，
改了各层清单就只剩一列 id。

**两个后果要注意：**

1. **改模板会让全部已 approve 文档的哈希失效**（章节表变了，哈希取材就变了），
   所有对象进入偏离态，需要重走 approve。要改就在项目早期改。
2. **重跑 init 会整目录覆盖 templates，项目内的定制会丢**。当前没有为模板定制提供保护，
   要长期定制就改母版 `assets/templates/`，不要只改项目内的副本。

---

## 母版约定

改 `assets/` 时按这两条走，它们只约束母版自身，不影响生成出来的项目。

### schema 进模板，其余全进 skill

| 内容 | 归属 |
|---|---|
| 章节标题与顺序、front-matter 字段白名单 | `assets/templates/` |
| 某一节写什么、什么时候该拆、复用还是新建、参考区间 | `assets/skills/` |

界线是**谁读它**：模板剩下的部分只有脚本读，`loadTemplateSpec` 由此解析出校验规则；
其余都是写给 AI 的，而 AI 动笔那一刻必然加载 skill，不一定会去读模板。

同一条要求只留一处。skill 里不要写「以模板为准」——模板里已经没有内容可依。
能被 validate 卡住的格式细节（字数、编号、slug 写法）连 skill 也不必写，报错会告诉它。

### mermaid：陶土橙 = 人，灰蓝 = AI

七个 skill 的流程图里，凡是**要停下等人**或**交人处理**的节点，一律：

```
    P1[/人 答复澄清/]
    classDef default fill:#f3f6f8,stroke:#9aa8b4,color:#27313a
    classDef human fill:#f3e6df,stroke:#c77a5c,color:#4a2c21,stroke-width:2px
    class P1,P2 human
```

平行四边形取「输入」的传统含义，人的答复正是输入。图后跟一句「陶土橙色节点是人的介入点，
灰蓝色节点是 AI 的工作；你必须在人的介入点停下等待」。

**不要只把人写在边的标签上**（`E -->|人选通过| F`）。人在这些位置是阻塞点，
写成边标签时它在图上不占位置，AI 顺着节点往下读就滑过去了——节点占位置，才拦得住。
