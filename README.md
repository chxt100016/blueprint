# blueprint

规范驱动的开发流水线。

人用自然语言描述业务需求，AI 逐层细化为标准流程与业务活动，人在每层确认后 AI 实现代码，
脚本负责一切确定性判断。

本仓库是 **skill 包的源码**，不是某个业务项目。装到业务项目里之后，
它会在那个项目下生成 `blueprint/` 目录与六个专属 skill。

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
代码布局与编译命令，再拷贝生成物。也可以直接跑脚本：

```bash
node ~/.claude/skills/blueprint/assets/bootstrap.mjs \
  --root <目标项目> --project shop --type fullstack \
  --layout-backend "src/modules/{capability}/" \
  --layout-frontend "src/pages/{capability}/" \
  --layout-domain "src/domain/{name}/" \
  --verify-backend "npx tsc --noEmit -p tsconfig.server.json" \
  --verify-frontend "npx tsc --noEmit -p tsconfig.web.json"
```

日常推进用生成出来的 `pipeline-<project>` skill；`blueprint` skill 只管 init。

## 目录

```
skills/blueprint/
  SKILL.md                 全局 skill:init
  assets/
    bootstrap.mjs          母版入口，只负责初始化/刷新目标项目
    bp-assets.json         母版资产标记
    scripts/bp.mjs         项目运行时入口，供六个生成 skill 调用
    scripts/lib/
      hash.mjs             全项目哈希的唯一实现
      parse.mjs            md / front-matter / YAML 子集 / mermaid 解析
      config.mjs           config.yaml 与作用域推导
      repo.mjs             仓库模型:一次性把 product/spec/domain/lock/todo 读进内存
      schema.mjs           模板与引用校验(validate)
      review.mjs           澄清记录的解析与读写
      stage.mjs            stage 判定与分层 scan
      db.mjs               snapshot 的导出与比对
      codemap.mjs          业务活动/领域能力到代码文件的索引
    templates/{backend,fullstack}/   五份文档模板
    config/{backend,fullstack}.yaml  config 骨架
    skills/*.md            六个 *-{project} skill 的母版
    WORKFLOW.md CONVENTIONS.md context-README.md
```

六个生成 skill：`pipeline` `flow` `activity` `domain` `code` `commit`，
与除 `orphaned` / `blocked` / `ready` 外的每个 stage 一一对应。

## 术语与写入者

| 层 | 载体 | 粒度 | 写入者 |
|---|---|---|---|
| 商业能力 | `blueprint/product/<capability>.md` 一个文件 | 业务归属域 | 人 |
| 业务服务 | product 文件里的一个二级标题（锚点） | 一次对外交付 | 人 |
| 业务流程 | `blueprint/spec/<capability>/<service>/<flow>.md` | **一个对外接口** | flow skill |
| 业务活动 | `blueprint/spec/<capability>/<service>/<activity>/activity.md` | 一次状态变更 | activity skill |
| 业务动作 | activity.md 里的 `A1 A2 A3` | 一步可判定的操作 | activity skill |

一个业务服务可以有多个业务流程——同一次交付有多个入口形态时（调用方在它们之间二选一），
一个接口一份流程文件。业务活动归属服务而不是流程，同一个服务的多个流程共享一个活动池，
流程文件的「活动编排」列出本流程用到哪些活动：

```
blueprint/spec/<capability>/<service>/
  service.md          知识记录，不参与任何判定
  <flow-a>.md         一个对外接口
  <flow-b>.md         另一个对外接口
  <activity>/         业务活动，可被上面多个流程编排
```

外加一个横切层：

| 层 | 载体 | 写入者 |
|---|---|---|
| 领域能力 | `blueprint/domain/<domain>/<name>/domain.md`，id 以 `@` 开头 | domain skill |

id 的第三段是固定的层级标记：流程是 `<cap>.<svc>.flow.<name>`，活动是 `<cap>.<svc>.activity.<name>`。
两者都挂在服务下，标记段让 id 自解释，解析时不必查表。

代码实现与 `blueprint/codemap/<capability>/<service>/<activity>.yaml` 索引由 code skill 写入，
提交由 commit skill 执行，二者都不写上面这六层的任何文档。

**每层文档只有一个写入者，跨层意见一律走澄清。** 这张表同时生成到项目内的
`blueprint/WORKFLOW.md`（「五层业务架构」一节），六个 skill 各自只声明所属层次并指向那里，
不重复携带整张表。

## 体系要点

- **产物层次对应业务架构层次**：商业能力 → 业务服务 → 业务流程 → 业务活动 → 业务动作，
  领域能力是横切层，独立成一个阶段。
- **业务流程的划分判据是对外接口**：数几个接口就划几个流程。接口是客观事实，
  不靠判断，也不会因为措辞不同而产生分歧。
- **两个「能力」分属不同层**：商业能力 `capability` 是 product 里的业务归属域，
  领域能力 `domain` 是跨服务复用的横切能力。命名上严格区分，不通用。
- **每层文档只有一个写入者**，跨层意见一律走澄清。人不直接改 AI 的文档，AI 不改 product。
- **全项目只有一个 stage**，它回答的问题只有一个：现在该调哪个 skill。
  取件顺序按依赖链正向推进，新写的 product 锚点排在最后，因此中途加需求不会打断当前这一波。
- **三道确认门**：`flow approve`（逐个流程）、`activity approve`（按服务）、`domain approve`。
  每道门都是 AI 先打印完整变更清单、人选「通过」或「我要补充」，选了通过 AI 才执行 approve。
  **code 阶段没有门**——设计决策已在前三道定完，正确性由 verify 判定。
- **澄清在会话内完成**。flow / activity / domain 每轮至少提 3 个问题，用选择工具问人，
  当场答不上来可以留到下一轮。答复与落点由脚本记进 `*.review.md`，AI 不碰这个文件的格式。
- **stage 由脚本判定，skill 只查表**。模型不参与任何状态推理，重跑必然得到同一结果，
  断点续跑天然成立。
- **代码不计算哈希**。lock 只回答「这份文档有没有被实现过、实现时对应哪个版本」，
  代码的变更历史由 git 承担。

完整命令表见 `bp help`，人的操作手册见项目内生成的 `blueprint/WORKFLOW.md`。

## 实现相对规范 v3 的补充与偏差

规范没写死、或实现时必须做出选择的地方，都记在这里：

1. **stage 是全局的，不是每个对象一个**。规范给每个对象各自判定 stage，实现上改为
   「整个项目当前处于哪一层」，因为流水线的每一步都要人参与，同时推进多层会让人
   在不同抽象层级之间反复切换。取件顺序为
   `orphaned → blocked → flow → activity → domain → code → commit → 新锚点 → ready`。
2. **未认领的 product 锚点排在最后**。人中途往 product 里加新业务服务不会打断当前这一波，
   它会等整条链清空。这是「先把手上的活干完」的机制保障，不依赖人自觉。
3. **领域能力独立成 `domain` 阶段**。规范把能力文档的产出挂在活动层的 approve 上，
   实现上拆开：activity 只识别并登记 `uses`（且新提取的候选要问人），
   domain 阶段负责设计契约并单独 approve。代价是多一个阶段，收益是每个 skill 只对一个抽象层负责。
4. **每层内的对象状态有四种**：`todo` / `review` / `approve` / `done`。
   区分「上游变了但本层还没跟进」与「本层已跟进等确认」，靠比对本层文档自身的哈希——
   上游哈希对不上而本层文档也变了，说明 skill 已经动过手。没有这个区分，
   「上游变更 → 本层重做」会死循环。
5. **code 层另有 `blocked` 与 `waiting` 两个状态**。前者等人（todo 工单、schema 缺口），
   后者等 domain 层先产出契约。`waiting` 不参与 stage 判定——把它算作 `blocked` 会让
   全局卡在 blocked（排在 domain 之前），而人对此无事可做。
6. **review 机制重做**。规范的三区（待确定/改动建议/已解决）+ 人手写 `>` 答复，
   改为脚本独占读写的两区（待答复/已答复）与三条命令 `ask` / `answer` / `resolve`，
   人的答复通过选择工具当场收集。保留了规范里最关键的一环：resolve 必须写落点，
   落点进入确认清单——AI 声称按答复改了却没改，不产生 diff、不触发校验，人过目是唯一捕获时机。
7. **lock 的领域能力 spec 段增加 `contract_fields`**。§7.6 第 7 条要求校验契约只增不改，
   而 lock 里只有哈希还原不出字段表，因此 approve 时一并记录契约表首列。
8. **lock 增加 `rejected_domains`**。人否决过的能力提取候选记在这里，
   避免 activity skill 每轮重新识别、重复询问同一件事。
9. **业务活动归属服务，不归属流程**。一个服务的多个流程（对外接口）共享一个活动池，
   活动目录与流程文件同层。这样同一次交付的不同入口能直接复用活动，
   不必为了共用而把步骤上升成领域能力；代价是改一个共用活动会影响多个接口，
   由 `activity changes` 标注影响面、人在确认门把关。
10. **`service.md` 是轻文档**。它记录服务边界与流程/活动登记，供后续阶段读，
   但脚本不校验、不哈希、不盖章，也不产生 stage。契约由流程文件与 activity.md 承担。
   服务层因此不增加确认门，人的三道门不变。
11. **commit 覆盖整条流水线的产出，不限单个业务服务**。一波需求里多个服务一起推进，
   它们属于同一次提交。提交信息按五层业务架构分行，由脚本生成。
   触发判据是「`lock.json` 有未提交变更且 lock 非空」——落在 lock 而非整个 `blueprint/` 目录，
   否则 init 刚生成的文件、人手写的 product 变更都会被误判成「有产出待提交」。
12. **不校验流程图节点与流程步骤的对应关系**。归一化只能抹平标点与空白，抹不平措辞，
   图文说的是同一件事却因几个字不同而卡住 approve，代价大于它保障的可读性。
   只校验「含且仅含一个 mermaid 块、首行为 `flowchart`」与「『流程』是有序步骤」。
13. **lib 比规范多两个模块**：`repo.mjs`（仓库模型）与 `db.mjs`（snapshot）。
   母版安装逻辑完全收在独立的 `bootstrap.mjs`，不进入项目运行时。规范列出的七个模块职责不变。
14. **`schema pull` 依赖系统自带的 CLI**（`pg_dump` / `mysqldump` / `sqlite3`），
   以保持脚本零 npm 依赖。sqlite 路径已端到端验证；postgres 与 mysql 走同一套语句拆分逻辑，
   但未在真实库上实测。
15. **`commit context` 的新增/修改判定依赖 `git status`**。非 git 仓库时无法区分，
   一律算作修改。提交信息不细到业务动作（`A1 A2`）一级——那需要 `git show` 取旧版本逐个解析，
   多轮 git 调用换来的信息量不值。
16. **没有 upgrade 与 doctor**。母版仍在迭代，暂不为存量项目的平滑升级与安装体检投入；
   `init` 幂等（生成物覆盖、定制物保留），重跑它就是刷新生成物。代价是 `config.yaml`
   新增字段要手动补，模板结构变了要人工迁移文档。母版稳定后再补这两条命令。
17. **模板是校验的唯一真相源**。规范把章节结构写在文档里，实现上则由 `config.mjs`
   从 `blueprint/templates/*.md` 解析出章节表、哈希取材、编号前缀与 front-matter 字段白名单，
   校验不再硬编码任何章节名。模板用 `<!-- bp: no-hash -->` 标记不参与哈希的章节，
   用 `<!-- bp: numbered=A -->` 声明编号前缀。代价是改模板会让已 approve 文档的哈希失效，
   且重跑 init 覆盖 templates 时项目内的定制会丢。
18. **活动与能力的「行为规则」章节改称「动作」，编号 `R` 改为 `A`**，与业务架构层次里的
   「业务动作」对齐。这是纯模板改动，脚本无需改动即生效。

规范 §19 已知限制（type 中途变更、重命名等价于删除重建、schema pull 连生产库、
tables 只声明列名、代码不计算哈希、并发协作未定义、以编译为门禁）在本实现中同样存在。
**并行开发暂不支持**：整个项目按波次推进，中途插入的需求要等下一轮，或用 git worktree 隔离。
