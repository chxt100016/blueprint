# blueprint

规范驱动的开发流水线，按《Blueprint 实施规范 v3》实现。

人用自然语言描述业务需求，AI 逐层细化为标准流程与业务活动，人在每层确认后 AI 实现代码，
脚本负责一切确定性判断。

本仓库是 **skill 包的源码**，不是某个业务项目。装到业务项目里之后，
它会在那个项目下生成 `blueprint/` 目录与九个专属 skill。

## 安装

```bash
npx skills add chxt100016/blueprint -g
```

推荐用 `-g` 装到全局（`~/.claude/skills/`）——blueprint 是拿来给**任意**项目做 init 的，
装在单个项目里反而别扭。其他形态：

```bash
npx skills add chxt100016/blueprint                     # 只装到当前项目 .claude/skills/
npx skills add chxt100016/blueprint -g --agent claude-code  # 指定 agent
npx skills add chxt100016/blueprint -g --copy           # 不用软链，独立拷贝
npx skills add ./ -g                                    # 从本地路径装（改这个仓库时自测用）
```

管理：

```bash
npx skills list -g
npx skills update
npx skills rm chxt100016/blueprint --all
```

装完在目标项目里对 Claude 说「初始化 blueprint」即可。它会问清项目名、类型、
代码布局、编译命令、数据库方言，再拷贝生成物。也可以直接跑脚本：

```bash
node ~/.claude/skills/blueprint/assets/scripts/bp.mjs init \
  --root <目标项目> --project shop --type fullstack \
  --layout-backend "src/modules/{domain}/" \
  --layout-frontend "src/pages/{domain}/" \
  --layout-domain "src/domain/{capability}/" \
  --verify-backend "npx tsc --noEmit -p tsconfig.server.json" \
  --db-dialect postgres --db-migration-table schema_migrations
```

日常推进用生成出来的 `pipeline-<project>` skill；`blueprint` skill 只管 init / upgrade / doctor。

## 目录

```
skills/blueprint/
  SKILL.md                 全局 skill:init / upgrade / doctor
  assets/
    bp-assets.json         母版标记,bp.mjs 据此判断能否执行 init/upgrade
    scripts/bp.mjs         单入口,零 npm 依赖,只用 Node 内置模块
    scripts/lib/
      hash.mjs             全项目哈希的唯一实现
      parse.mjs            md / front-matter / YAML 子集 / mermaid 解析
      config.mjs           config.yaml 与作用域推导
      repo.mjs             仓库模型:一次性把 product/spec/domain/lock/todo 读进内存
      schema.mjs           模板与引用校验(validate)
      review.mjs           review 的解析、编号分配与条目迁移
      stage.mjs            stage 判定与 scan
      db.mjs               snapshot 的导出与比对
      codemap.mjs          活动/能力到代码文件的索引
      install.mjs          init / upgrade / doctor 的资产操作
    templates/{backend,frontend,fullstack}/   五份文档模板
    config/{backend,frontend,fullstack}.yaml  config 骨架
    skills/*.md            九个 *-{project} skill 的母版
    WORKFLOW.md CONVENTIONS.md context-README.md
```

九个生成 skill：`pipeline` `flow` `review-flow` `activity` `review-activity`
`domain` `code` `lock` `commit`。

## 体系要点

- **产物层次对应业务架构层次**：商业能力 → 业务服务 → 业务流程 → 业务活动 → 业务动作，
  领域能力是横切层，按需触发。
- **每层文档只有一个写入者**，跨层意见一律走 review。人不直接改 AI 的文档，AI 不改 product。
- **两道确认门**只能人执行：`approve flow` 确认流程与活动划分，`approve activity` 按服务批量确认活动。
- **scan 输出 stage，pipeline 只查表**。模型不参与任何状态推理，重跑必然得到同一结果，
  断点续跑天然成立。
- **代码不计算哈希**。lock 只回答「这份文档有没有被实现过、实现时对应哪个版本」，
  代码的变更历史由 git 承担。

完整命令表见 `bp help`，人的操作手册见项目内生成的 `blueprint/WORKFLOW.md`。

## 实现相对规范 v3 的补充与偏差

规范没写死、或实现时必须做出选择的地方，都记在这里：

1. **新增 `unclaimed` stage**。product 里有锚点但还没有任何 flow.md 引用它时，
   scan 会把该锚点列为 `unclaimed`。规范的 stage 表里没有这一条，但服务 id 与锚点的对应
   由 flow.md 单向声明，没有它 pipeline 无从发现「人新写了一个服务」。
2. **`scan --json` 增加 `next` 字段**，直接给出 pipeline 该处理的对象。
   取件顺序（服务先于对象、能力先于引用它的活动、同服务按 `depends_on` 拓扑）由脚本决定，
   模型不参与排序。
3. **lock 的能力 spec 段增加 `contract_fields`**。§7.6 第 7 条要求校验契约只增不改，
   而 lock 里只有哈希还原不出字段表，因此 approve 时一并记录契约表首列。
4. **流程图节点与流程步骤按主干比较**。步骤允许在主干后用冒号或逗号追加补充说明
   （规范自己的示例第 5、6 步就是这么写的），图上只画主干，比较时两边同样截断。
5. **review 编号 Q 与 C 共享同一个递增空间**。`review resolve <id> <编号>` 只按数字寻址，
   两套独立序列会撞号。
6. **lib 比规范多三个模块**：`repo.mjs`（仓库模型）、`db.mjs`（snapshot）、
   `install.mjs`（init/upgrade）。规范列出的七个模块职责不变。
7. **未 approve 的活动不出现在 scan 的活动级清单里**。它们的待办已经由所属服务的
   `activity_pending` 表达，重复列出会让同一件事被计两次。
8. **`schema pull` 依赖系统自带的 CLI**（`pg_dump` / `mysqldump` / `sqlite3`），
   以保持脚本零 npm 依赖。sqlite 路径已端到端验证；postgres 与 mysql 走同一套语句拆分逻辑，
   但未在真实库上实测。
9. **`commit-context` 的新增/修改判定依赖 `git status`**。非 git 仓库时无法区分，
   一律算作修改。
10. **`bp upgrade` 会自动改写 `config.yaml` 的 `blueprint_version`**，不留给人手改。

规范 §19 已知限制（type 中途变更、重命名等价于删除重建、schema pull 连生产库、
tables 只声明列名、代码不计算哈希、并发协作未定义、以编译为门禁）在本实现中同样存在。
