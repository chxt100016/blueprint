---
name: blueprint
description: 仅在用户明确要求「初始化 blueprint」或「刷新 blueprint 生成物」时使用。不参与日常流水线——日常推进用 pipeline-<project> skill。
license: MIT
compatibility: 需要 Node.js 18+（脚本零 npm 依赖，只用内置模块）；schema pull 另需系统自带的 pg_dump / mysqldump / sqlite3
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
就能把新的 `scripts/` `templates/` 与六个 skill 刷进项目，因此不另设 upgrade 命令。

## 定位母版

以下用 `SKILL_DIR` 代指本 SKILL.md **实际所在目录**，`BOOTSTRAP` 代指 `$SKILL_DIR/assets/bootstrap.mjs`。
`BOOTSTRAP` 是独立的单文件安装器，只读取同级母版资产，不复用也不进入项目内的 `blueprint/scripts/`。

具体路径取决于装法：手动拷贝就是 `.claude/skills/blueprint/` 或 `~/.claude/skills/blueprint/`；
用 `npx skills add` 装的话，母本通常在 `~/.agents/skills/blueprint/`，
再由 `~/.claude/skills/blueprint` 软链暴露——两条路径都能直接 `node` 运行，
Node 会把软链解析成真实路径，`assets/` 就在旁边。不确定时先 `ls $SKILL_DIR/assets/bootstrap.mjs` 确认。

初始化或刷新必须用 `BOOTSTRAP` 运行；`BP` 只指项目内的 `node blueprint/scripts/bp.mjs`，
不再承担母版安装职责。

---

## init

### 1. 询问并确认

逐项问清楚，不要替用户猜。每项都给出建议值，让用户确认或改：

| 项 | 说明 | 建议值 |
|---|---|---|
| 项目名 | 会变成六个 skill 的后缀，如 `pipeline-shop` | 取仓库目录名 |
| 项目类型 | `backend` / `fullstack`，决定 activity 是否含「交互」章节与 verify 范围 | 有前端目录用 `fullstack`，否则用 `backend` |
| 代码布局 | `layout.backend` / `layout.frontend` / `layout.domain` 的模板串 | 先扫一眼现有目录结构再建议 |
| 编译命令 | `verify.backend` / `verify.frontend` | 从 package.json 的 scripts 里找 |

布局模板串支持两组占位符：`{capability}`、`{service}`（业务活动）与 `{name}`（领域能力）。

```
src/modules/{capability}/  →  order.create.apply-coupon  得到  src/modules/order/
src/domain/{name}/         →  @pricing.discount          得到  src/domain/discount/
```

注意两个「能力」分属不同层，词不通用：`{capability}` 是**商业能力**（`product/<capability>.md`），
`{name}` 是**领域能力**的能力名（`domain/<domain>/<name>/`）。

**`config.type` 中途变更没有迁移路径**（改了之后全部已 approve 的活动文档都要重新确认），
所以这一项要问清楚再定。

### 2. 执行

```
node $SKILL_DIR/assets/bootstrap.mjs \
  --root <项目根> \
  --project <项目名> \
  --type <backend|fullstack> \
  --layout-backend "src/modules/{capability}/" \
  --layout-frontend "src/pages/{capability}/" \
  --layout-domain "src/domain/{name}/" \
  --verify-backend "npx tsc --noEmit -p tsconfig.server.json" \
  --verify-frontend "npx tsc --noEmit -p tsconfig.web.json"
```

脚本会：拷贝 `scripts/` 与对应类型的 `templates/`；生成 `config.yaml`、`WORKFLOW.md`、
`context/README.md`、`CONVENTIONS.md` 骨架、空 `lock.json`；生成六个 `*-<project>` skill
（pipeline / flow / activity / domain / code / commit）；
追加 `.gitignore`（排除 `blueprint/context/db.yaml`，该文件允许写明文凭据）。
**拷贝一律用文件复制，不用模型生成。**

### 3. 收尾提示

告诉用户还需要手动做四件事：

1. 手写 `blueprint/CONVENTIONS.md`——code skill 每次都会读它，写得越具体代码越贴合
2. 写 `blueprint/context/db.yaml`（不入库）
3. 首次运行 `node blueprint/scripts/bp.mjs schema pull`
4. 按本项目实际结构填 `config.always_readable`（共享工具、类型定义那类目录），
   init 不猜这一项，留空则每次 `bp scope` 只给活动自己的目录

然后在 `blueprint/product/` 下写第一个商业能力文件，调用 `pipeline-<project>` 开始。

### 存量项目接入

已有代码的项目不要试图一次性把全仓纳入。按这个顺序：

1. `init` → `schema pull`
2. 挑 1~2 个近期在改的业务服务，人写 product 锚点（一个标题写一次完整的对外交付）
3. flow skill 按对外接口划分流程、生成活动编排 → 逐个 `bp flow approve <flow>`
4. activity skill 生成活动文档 → `bp activity approve <service>`（一次覆盖该服务全部活动）
5. domain skill 补齐被 `uses` 引用的领域能力 → `bp domain approve <@id>`
6. 人手写这些活动的 codemap
7. `bp code adopt --all` 把当前状态盖章为基线（跳过 verify，但仍校验 validate 与 codemap）
8. 之后只在动到某个业务服务时才为其补文档并 adopt 一次

未纳入的代码不会出现在 `bp stage` 与 `bp scan` 的输出中。

---

## 刷新生成物

母版改了、想把新版刷进已有项目时，用原来那条 init 命令重跑即可：

```
node $SKILL_DIR/assets/bootstrap.mjs --root <项目根> --project <项目名> --type <类型>
```

生成物覆盖，定制物保留。**`config.yaml` 已存在就完全不动**——母版新增了配置字段的话，
按母版 `assets/config/<type>.yaml` 手动补进去。

**改了模板或章节结构的话**，已 approve 的文档会因为哈希取材变化而全部进入偏离态，
需要人工把文档改成新结构再重走 approve。当前没有迁移工具，这是刻意留白：
母版稳定之前不值得为它写自动化。

---

## 生成物与定制物

| 路径 | 归属 | 重跑 init |
|---|---|---|
| `.claude/skills/*-<project>/SKILL.md` | 生成物 | 覆盖 |
| `blueprint/scripts/` `WORKFLOW.md` | 生成物 | 覆盖 |
| `blueprint/templates/` | 生成物,但**是校验真相源** | 覆盖(定制会丢) |
| `blueprint/config.yaml` | 定制物(init 时生成一次) | 不动 |
| `blueprint/CONVENTIONS.md` `product/` `context/` | 定制物 | 不动 |
| `blueprint/spec/` `domain/` `codemap/` `lock.json` | 定制物 | 不动 |

### 关于 templates

`blueprint/templates/` 不只是给 AI 抄的样板——**章节表、哈希取材、编号前缀、front-matter 字段白名单
全部由脚本从这些文件解析得到**（`config.mjs` 的 `loadTemplateSpec`）。改模板即改校验，不必动代码。

模板内的 `<!-- bp: ... -->` 标记：

| 标记 | 作用 |
|---|---|
| `<!-- bp: no-hash -->` | 该章节不参与文档哈希(「实现提示」用它) |
| `<!-- bp: numbered=A -->` | 该章节需形如 `A1 A2` 的连续编号 |

front-matter 的键即允许出现的字段；`entry` 的子键即该 type 下必填的入口。

**两个后果要注意：**

1. **改模板会让全部已 approve 文档的哈希失效**（章节表变了，哈希取材就变了），
   所有对象进入偏离态，需要重走 approve。要改就在项目早期改。
2. **重跑 init 会整目录覆盖 templates，项目内的定制会丢**。当前没有为模板定制提供保护，
   要长期定制就改母版 `assets/templates/`，不要只改项目内的副本。
