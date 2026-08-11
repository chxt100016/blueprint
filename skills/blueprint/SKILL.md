---
name: blueprint
description: 初始化、升级或体检一个项目的 blueprint 规范驱动流水线。仅在用户明确要求「初始化 blueprint」「升级 blueprint」「blueprint doctor」时使用，不参与日常流水线——日常推进用 pipeline-<project> skill。
license: MIT
compatibility: 需要 Node.js 18+（脚本零 npm 依赖，只用内置模块）；schema pull 另需系统自带的 pg_dump / mysqldump / sqlite3
metadata:
  version: "1.0.0"
  author: chxt100016
---

# blueprint

规范驱动的开发流水线：人用自然语言描述业务需求，AI 逐层细化为标准流程与业务活动，
人在每层确认后 AI 实现代码，脚本负责一切确定性判断。

**本 skill 只做三件事：init、upgrade、doctor。低频、影响面大，不应被日常流水线意外命中。**
日常推进用生成出来的 `pipeline-<project>` skill。

## 定位母版

以下用 `SKILL_DIR` 代指本 SKILL.md **实际所在目录**，`BP_SRC` 代指 `$SKILL_DIR/assets/scripts/bp.mjs`。

具体路径取决于装法：手动拷贝就是 `.claude/skills/blueprint/` 或 `~/.claude/skills/blueprint/`；
用 `npx skills add` 装的话，母本通常在 `~/.agents/skills/blueprint/`，
再由 `~/.claude/skills/blueprint` 软链暴露——两条路径都能直接 `node` 运行，
Node 会把软链解析成真实路径，`assets/` 就在旁边。不确定时先 `ls $SKILL_DIR/assets/scripts/bp.mjs` 确认。

`init` 与 `upgrade` 必须用 `BP_SRC` 运行（项目内拷贝的 `blueprint/scripts/bp.mjs` 不含母版资产，会直接报错）。
其余命令用项目内的 `node blueprint/scripts/bp.mjs`。

---

## init

### 1. 询问并确认

逐项问清楚，不要替用户猜。每项都给出建议值，让用户确认或改：

| 项 | 说明 | 建议值 |
|---|---|---|
| 项目名 | 会变成九个 skill 的后缀，如 `pipeline-shop` | 取仓库目录名 |
| 项目类型 | `backend` / `frontend` / `fullstack`，决定 activity 是否含「交互」章节与 verify 范围 | 看仓库里有没有前端目录 |
| 代码布局 | `layout.backend` / `layout.frontend` / `layout.domain` 的模板串 | 先扫一眼现有目录结构再建议 |
| 编译命令 | `verify.backend` / `verify.frontend` | 从 package.json 的 scripts 里找 |
| 数据库方言 | `postgres` / `mysql` / `sqlite` | 从依赖或配置里找 |
| migration 表名 | 用于取 `source_version` | `schema_migrations` |

布局模板串支持 `{domain}`、`{service}`（活动）与 `{capability}`（领域能力）两组占位符：

```
src/modules/{domain}/     →  order.create.apply-coupon  得到  src/modules/order/
src/domain/{capability}/  →  @pricing.discount          得到  src/domain/discount/
```

**`config.type` 中途变更没有迁移路径**（改了之后全部已 approve 的活动文档都要重新确认），
所以这一项要问清楚再定。

### 2. 执行

```
node $SKILL_DIR/assets/scripts/bp.mjs init \
  --root <项目根> \
  --project <项目名> \
  --type <backend|frontend|fullstack> \
  --layout-backend "src/modules/{domain}/" \
  --layout-frontend "src/pages/{domain}/" \
  --layout-domain "src/domain/{capability}/" \
  --verify-backend "npx tsc --noEmit -p tsconfig.server.json" \
  --verify-frontend "npx tsc --noEmit -p tsconfig.web.json" \
  --db-dialect postgres \
  --db-migration-table schema_migrations
```

脚本会：拷贝 `scripts/` 与对应类型的 `templates/`；生成 `config.yaml`、`WORKFLOW.md`、
`context/README.md`、`CONVENTIONS.md` 骨架、空 `lock.json`；生成九个 `*-<project>` skill；
追加 `.gitignore`（排除 `blueprint/context/db.yaml`，该文件允许写明文凭据）；
写 `.manifest.json` 供 doctor 比对。**拷贝一律用文件复制，不用模型生成。**

### 3. 收尾提示

告诉用户还需要手动做三件事：

1. 手写 `blueprint/CONVENTIONS.md`——code skill 每次都会读它，写得越具体代码越贴合
2. 写 `blueprint/context/db.yaml`（不入库）
3. 首次运行 `node blueprint/scripts/bp.mjs schema pull`

然后在 `blueprint/product/` 下写第一个域文件，调用 `pipeline-<project>` 开始。

### 存量项目接入

已有代码的项目不要试图一次性把全仓纳入。按这个顺序：

1. `init` → `schema pull`
2. 挑 1~2 个近期在改的服务，人写 product 锚点
3. flow skill 生成流程与活动划分 → 人 `approve flow`
4. activity skill 生成活动文档 → 人 `approve activity`
5. 人手写这些活动的 codemap
6. `bp lock adopt --all` 把当前状态盖章为基线（跳过 verify，但仍校验 validate 与 codemap）
7. 之后只在动到某服务时才为其补文档并 adopt 一次

未纳入的代码不会出现在 `bp scan` 输出中。

---

## upgrade

1. 对比项目 `config.yaml` 的 `blueprint_version` 与母版版本，输出两版之间的变更说明。
2. 执行：

   ```
   node $SKILL_DIR/assets/scripts/bp.mjs upgrade --root <项目根>
   ```

   整目录覆盖 `scripts/`、`templates/`、`WORKFLOW.md`、九个 skill 文件；
   `config.yaml` 做字段级合并（新增字段带默认值追加到文件末尾，已有值保留，
   `blueprint_version` 由脚本改写）；`project` 改名时删除旧名的 skill 目录；重写 `.manifest.json`。

3. lock 格式若有变更，按变更说明执行迁移并更新 `version`。

**定制物不动**：`CONVENTIONS.md`、`product/`、`context/`、`spec/`、`domain/`、`codemap/`、`lock.json`。

---

## doctor

```
node blueprint/scripts/bp.mjs doctor
```

比对 `.manifest.json` 检查生成物是否被手改，检查目录完整性与版本是否落后。

**生成物被手改时不要直接覆盖**——先问清楚用户改了什么、为什么。
多数情况下那个需求应该通过 `config.yaml` 表达；确实表达不了的，是母版该改。

---

## 生成物与定制物

| 路径 | 归属 | upgrade |
|---|---|---|
| `.claude/skills/*-<project>/SKILL.md` | 生成物 | 覆盖 |
| `blueprint/scripts/` `templates/` `WORKFLOW.md` | 生成物 | 覆盖 |
| `blueprint/config.yaml` | 混合 | 字段级合并 |
| `blueprint/CONVENTIONS.md` `product/` `context/` | 定制物 | 不动 |
