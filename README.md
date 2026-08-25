# blueprint

规范驱动的开发流水线。

人用自然语言描述业务需求，AI 逐层细化为标准流程与业务活动，人在每层确认后 AI 实现代码，
脚本负责一切确定性判断。

本仓库是 **skill 包的源码**，不是某个业务项目。装到业务项目里之后，
它会在那个项目下生成 `blueprint/` 目录、六个流水线 skill 与一个按需 UI skill。

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

装完在目标项目里对 Claude 说「初始化 blueprint」即可。它会问清项目名、
应用代码布局与验证命令，再拷贝生成物。也可以直接跑脚本：

```bash
node ~/.claude/skills/blueprint/bootstrap.mjs \
  --root <目标项目> --project shop \
  --layout-app "src/modules/{capability}/" \
  --layout-domain "src/domain/{name}/" \
  --verify-app "npx tsc --noEmit -p tsconfig.server.json"
```

日常推进用生成出来的 `pipeline-<project>` skill；`blueprint` skill 只管 init。
实现界面时按需调用 `ui-<project>`，并提供一个已确认的 flow ID。

## 使用

1. 在 `blueprint/product/<商业能力>/<业务服务>.md` 里写这个业务服务的描述——
   **一份文件就是一个业务服务**，目录名与文件名用英文 kebab-case，路径即 id。
2. 反复调用 `pipeline-<project>` skill，直到它报告全部就绪。

全项目任意时刻只有一个 stage，可用 `node blueprint/scripts/bp.mjs stage` 查看：

| stage | 处理者 |
|---|---|
| `flow` | flow skill |
| `activity` | activity skill |
| `domain` | domain skill |
| `code` | code skill |
| `commit` | commit skill |
| `none` | 无待办 |

流水线依次按 `flow → activity → domain → code → commit → none` 推进——取件顺序就是依赖链本身。

两类「AI 推不动」的事不占 stage，只作为附注打在 `bp stage` 的输出里，不阻断分派：
引用断裂的对象（重命名后的残留）打在顶部作告警，等人执行工单或补表结构的对象列在末尾。
它们等的人做的事与当前 stage 该做的事互不相干，卡住流水线只会让 AI 无谓地停工。

人只需要在四类节点介入：

- 确认 flow skill 给出的流程划分方案——在它动笔写文档之前。划分是这一层代价最高的决策，
  划错了下面的活动与代码全要返工。
- 回答 flow / activity / domain skill 的澄清问题。
- 审核 `flow changes`、`activity changes`、`domain changes` 打印的变更清单；确认后 skill 才会执行 approve。
- 执行 `blueprint/todo/` 中的副作用工单，完成后移入 `blueprint/todo/done/`，数据库变更再执行 `node blueprint/scripts/bp.mjs snapshot pull db`。

常用命令：

```bash
node blueprint/scripts/bp.mjs stage              # 查看当前 stage 与全局进度
node blueprint/scripts/bp.mjs scan <layer>       # 某层待办明细
node blueprint/scripts/bp.mjs new <id>           # 按 id 建文档骨架(id 即路径)
node blueprint/scripts/bp.mjs validate [<id>]    # 校验文档与引用,含表结构比对
node blueprint/scripts/bp.mjs snapshot pull db   # 导出全库结构
node blueprint/scripts/bp.mjs snapshot pull rpc  # 按 context/rpc 里的 curl 采样外部接口
node blueprint/scripts/bp.mjs help               # 完整命令表
```

## 目录

```
skills/blueprint/
  SKILL.md                 全局 skill:init
  bootstrap.mjs           母版入口，只负责初始化/刷新目标项目
  assets/
    scripts/bp.mjs         项目运行时入口
    scripts/lib/
      hash.mjs             全项目哈希的唯一实现
      parse.mjs            md / front-matter / YAML 子集 / mermaid 解析
      config.mjs           config.yaml 与作用域推导
      repo.mjs             仓库模型:一次性把 product/spec/domain/lock/todo 读进内存
      schema.mjs           模板与引用校验(validate)
      review.mjs           澄清记录的解析与读写
      stage.mjs            stage 判定与分层 scan
      db.mjs               db snapshot 的导出与比对
      rpc.mjs              外部 HTTP 接口的采样与快照
      codemap.mjs          业务活动/领域能力到代码文件的索引
    templates/*.md         五份业务文档模板
    config.yaml            config 骨架
    skills/*.md            七个 *-{project} skill 的母版
    context-README.md
    rpc-README.md
```

六个流水线 skill：`pipeline` `flow` `activity` `domain` `code` `commit`，
与除 `none` 外的每个 stage 一一对应。
`ui-<project>` 由人给出已确认的 flow ID 后调用。它通过 BP 读取接口契约，使用
`blueprint/ui/` 中的项目级 UI 上下文确定页面落点并实现；首次使用时会先和人讨论并建立上下文。

## 术语与写入者

| 层 | 载体 | 粒度 | 写入者 |
|---|---|---|---|
| 商业能力 | `blueprint/product/<capability>/` 一个目录 | 业务归属域 | 人 |
| 业务服务 | `blueprint/product/<capability>/<service>.md` 一个文件 | 一次对外交付 | 人 |
| 业务流程 | `blueprint/spec/<capability>/<service>/<flow>.md` | **一个对外接口** | flow skill |
| 业务活动 | `blueprint/spec/<capability>/<service>/<activity>/activity.md` | 一次状态变更 | activity skill |
| 业务动作 | activity.md 里的 `A1 A2 A3` | 一步可判定的操作 | activity skill |

一个业务服务可以有多个业务流程——同一次交付有多个入口形态时（调用方在它们之间二选一），
一个接口一份流程文件。业务活动归属服务而不是流程，同一个服务的多个流程共享一个活动池，
流程文件的「活动编排」列出本流程用到哪些活动：

```
blueprint/product/<capability>/
  <service>.md        人写的业务描述，一份文件一个业务服务，整份参与哈希

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

三种 AI 产出的文档（flow / activity / domain）第一节都是 `## 概要`：**单行、不超过 40 字**，脚本硬校验。
各层清单（`bp scan flow`、`bp scan activity`、`bp domain list`）直接列它——
人和 AI 靠它在不打开文件的情况下认出一个对象，domain 那一层还靠它判断
「我要的能力是不是已经有了」，写不清楚就会被重复提取一份。

id 的第三段是固定的层级标记：流程是 `<cap>.<svc>.flow.<name>`，活动是 `<cap>.<svc>.activity.<name>`。
两者都挂在服务下，标记段让 id 自解释，解析时不必查表。

流水线中的实现与 `blueprint/codemap/<capability>/<service>/<activity>.yaml` 索引由 code skill 写入，
提交由 commit skill 执行，二者都不写上面这六层的任何文档。
code skill 自己不写代码：**一个业务活动/领域能力派一个 subagent**，它只做取读取清单、
派活、验收三件事，实现细节不进它的上下文。这一层没有人工介入点，是全流水线唯一能这么切的地方。

UI skill 维护另一类项目上下文：

```text
blueprint/ui/
  index.md           UI 方向、上下文索引、业务区域查找表
  foundation.md      全局视觉、布局、交互与无障碍原则
  navigation.md      页面树、路由归属和导航入口
  engineering.md     技术栈、源码入口、API/状态/组件与验证命令
  areas/<area>.md    某业务区域的页面、源码路径和 flow 映射
```

日常 UI 任务先读入口索引，再只展开命中的业务区域与必要的全局文件；代码读取也限定到上下文登记的路径。

**每层文档只有一个写入者，跨层意见一律走澄清。**

## 体系要点

- **产物层次对应业务架构层次**：商业能力 → 业务服务 → 业务流程 → 业务活动 → 业务动作，
  领域能力是横切层，独立成一个阶段。
- **业务流程的划分判据是对外接口**：数几个接口就划几个流程。接口是客观事实，
  不靠判断，也不会因为措辞不同而产生分歧。
- **路径即 id**：`product/order/checkout.md` 就是业务服务 `order.checkout`，
  `spec/order/checkout/submit.md` 就是业务流程 `order.checkout.flow.submit`，双向可推。
  文档因此不声明自己属于谁，建文档一律用 `bp new <id>`，路径由脚本算。
- **两个「能力」分属不同层**：商业能力 `capability` 是 product 里的业务归属域，
  领域能力 `domain` 是跨服务复用的横切能力。命名上严格区分，不通用。
- **每层文档只有一个写入者**，跨层意见一律走澄清。人不直接改 AI 的文档，AI 不改 product。
- **全项目只有一个 stage**，它回答的问题只有一个：现在该调哪个 skill。
  取件顺序按依赖链正向推进，新写的业务服务排在最后，因此中途加需求不会打断当前这一波。
- **三道确认门**：`flow approve`、`activity approve`、`domain approve`，前两道都按业务服务一轮一轮走。
  每道门都是 AI 先打印完整变更清单、人选「通过」或「我要补充」，选了通过 AI 才执行 approve。
  flow 层还有一道**准出闸门**：实际变更的流程必须与 AI 确认时列出的完全一致，
  否则拒绝盖章——防止「人看的是 B，改的却是 A」。
  **code 阶段没有门**——设计决策已在前三道定完，正确性由 verify 与**动作覆盖比对**判定：
  codemap 的每个文件用 `covers` 声明落实了哪几条业务动作，`bp code done` 要求
  文档里的 `A1 A2 A3` 每一条都被某个文件认领，少一条不放行。
- **澄清在会话内完成**。flow / activity / domain 每轮至少提 3 个问题，用选择工具问人，
  当场答不上来可以留到下一轮。答复与落点由脚本记进 `*.review.md`，AI 不碰这个文件的格式。
  **盖章后这些条目迁入该文件的「已确认」区长期留存**，不再删除——「当初为什么这样定」有据可查，
  下一轮改同一个对象时不会把已经否掉的方案又提一遍。
- **stage 由脚本判定，skill 只查表**。模型不参与任何状态推理，重跑必然得到同一结果，
  断点续跑天然成立。
- **代码不计算哈希**。lock 只回答「这份文档有没有被实现过、实现时对应哪个版本」，
  代码的变更历史由 git 承担。

完整命令表见 `bp help`。

## 实现相对规范 v3 的补充与偏差

规范没写死、或实现时必须做出选择的地方，都记在这里：

1. **stage 是全局的，不是每个对象一个**。规范给每个对象各自判定 stage，实现上改为
   「整个项目当前处于哪一层」，因为流水线的每一步都要人参与，同时推进多层会让人
   在不同抽象层级之间反复切换。取件顺序就是依赖链本身，没有旁支：
   `flow → activity → domain → code → commit → none`。
2. **「AI 推不动的事」不占 stage，只作附注**。有两类：引用断裂的残留对象（多半是重命名造成的），
   以及等人执行 todo 工单或补表结构的对象。前者打在 `bp stage` 输出顶部作告警，
   后者列在末尾，都不改变 stage、不打断分派。
   早先它们各占一个 stage（`orphaned` 排最前、`blocked` 排最后），问题是：
   孤儿不属于任何一层，没有哪个 skill 该拿它当待办（skill 的职责是产出文档，不是删东西），
   而排在最前会让一个重命名残留把整条线停死；`blocked` 虽然排在最后不至于卡住上游，
   但它与 `none` 想说的其实是同一件事——AI 没有能自动推进的事了。
   两者都降级成附注之后，人该做的事一件没少，AI 却不会再无谓停工。
3. **领域能力独立成 `domain` 阶段**。规范把能力文档的产出挂在活动层的 approve 上，
   实现上拆开：activity 只识别并登记 `uses`（且新提取的候选要问人），
   domain 阶段负责设计契约并单独 approve。代价是多一个阶段，收益是每个 skill 只对一个抽象层负责。
4. **层内不设对象状态**。一行只有 id 与 detail，判据是「detail 非空 = 有事要做」。
   状态词经历过两轮裁剪：activity / domain 两层最初各有一套
   `new` / `wait_review` / `wait_approve` / `complete` 的四态状态机，先压成四层共用的
   `new` / `updated` / `complete` 三态，最后整个删掉。
   四态的问题是把本该一起想的几个对象拆成互不相干的支线，且 `wait_review` 与 `wait_approve`
   的区分靠「本层文档自身哈希变没变」这个隐式约定，AI 只改了不参与哈希的章节时状态就不动。
   三态的问题是没有消费者：scan 与 stage 判定一律只过滤 `complete`，三层 skill 的文档
   也都写着「都从第一步进」——状态词想说的「新写还是改写」「上游变了还是澄清没结清」
   全在 detail 里，留着状态列只是把同一件事说两遍。
   「澄清结清没有」由 approve 的准出闸门兜底，不需要在 scan 阶段就分类。
   code 层的「等人」那组改用分组表达而非状态词，见第 2 条；活动 `uses` 的领域能力
   还没设计时也不单开一组，只在 detail 里标一句：那批 id 同时也是 domain 层的待办，
   而 domain 层排在 code 之前，全局判定走到 code 时它必然已经清空。
5. **snapshot 从没导出过时不判 schema 缺口**。空 snapshot 只说明还没跑过 `bp snapshot pull db`，
   不代表库里没有这些表。少了这道守卫，凡是在 front-matter 声明了 `tables` 的项目，
   整个 code 层都会被判成「等人补表结构」。判据与 `bp validate` 的表结构比对保持一致。
6. **review 机制重做**。规范的三区（待确定/改动建议/已解决）+ 人手写 `>` 答复，
   改为脚本独占读写的两区（待答复/已答复）与三条命令 `ask` / `answer` / `resolve`，
   人的答复通过选择工具当场收集。保留了规范里最关键的一环：resolve 必须写落点，
   落点进入确认清单——AI 声称按答复改了却没改，不产生 diff、不触发校验，人过目是唯一捕获时机。
7. **领域契约可以改，改动靠 `uses_hash` 级联到调用方**。§7.6 第 7 条要求契约只增不改，
   破坏性变更走「新建 v2 + 迁移 + 删除原对象」。但活动文档写的是需求不是契约
   （「领域依赖」只写输入与期望输出，不出现命令编号、不变量编号与错误标识），
   领域契约改了活动文档往往一个字都不用动，`activity_hash` 因此判不出来——
   真正的缺口是调用方的实现没人拉起来复核，不是设计不该改。改为 `bp code done`
   记录活动实现时一并存下它 `uses` 的全部领域模型的组合哈希，契约一变，
   引用它的活动全部回到 code 层重新实现。与活动层拿 `flows_hash` 当上游是同一个模式。
8. **人否决的能力提取候选不进 lock**。判据只有一条引用关系：活动写不写 `uses`。
   选「不提取」就不写 `uses`，domain 层自然看不到它，也就不会再问第二次；
   已经写了 `uses` 又判定不宜提取的，只能回 activity 层去掉那条引用——
   在引用还挂着的时候把「否决」记进 lock 并不能让 scan 清零，只会让人以为处理完了。
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
14. **`snapshot pull db` 依赖系统自带的 CLI**（`pg_dump` / `mysqldump` / `sqlite3`），
   以保持脚本零 npm 依赖。sqlite 路径已端到端验证；postgres 与 mysql 走同一套语句拆分逻辑，
   但未在真实库上实测。
15. **`commit context` 的新增/修改判定依赖 `git status`**。非 git 仓库时无法区分，
   一律算作修改。提交信息不细到业务动作（`A1 A2`）一级——那需要 `git show` 取旧版本逐个解析，
   多轮 git 调用换来的信息量不值。
16. **没有 upgrade 与 doctor**。母版仍在迭代，暂不为平滑升级与安装体检投入；
   `init` 幂等（生成物覆盖、定制物保留），重跑它就是刷新生成物。代价是 `config.yaml`
   新增字段要手动补，模板结构变了要人工迁移文档。母版稳定后再补这两条命令。
17. **模板是校验的唯一真相源**。规范把章节结构写在文档里，实现上则由 `config.mjs`
   从 `blueprint/templates/*.md` 解析出章节表、哈希取材、编号前缀与 front-matter 字段白名单，
   校验不再硬编码任何章节名。模板用 `<!-- bp: no-hash -->` 标记不参与哈希的章节，
   用 `<!-- bp: numbered=A -->` 声明编号前缀。代价是改模板会让已 approve 文档的哈希失效，
   且重跑 init 覆盖 templates 时项目内的定制会丢。
18. **活动与能力的「行为规则」章节改称「动作」，编号 `R` 改为 `A`**，与业务架构层次里的
   「业务动作」对齐。这是纯模板改动，脚本无需改动即生效。
19. **codemap 增加 `covers`，code 层由此获得一道确定性判定**。前三层各有一道人工确认门，
   code 层没有，而 verify 只判编译过不过——漏实现一条动作，两关都不会响。
   现在 codemap 的每个文件声明自己落实了哪几条 `A` 编号，`bp code done` 比对两个集合：
   少一条不放行，声明了文档里不存在的编号也不放行（那多半是文档改过而 codemap 没跟）。
   代价是已有 codemap 都要补 `covers`，没有兼容期。
20. **code 层按对象派 subagent**。它是唯一没有人工介入点的一层，输入边界由 `bp scope`
   给死，成功判据是 `bp code done` 的退出码——三个条件同时成立，才切得干净。
   前三层不能这么切：它们的核心是「问人、等人答」，subagent 停不下来等人，
   切进去等于让它替人回答澄清，三道门就废了。
   粒度是一个业务活动/领域能力一个 subagent，串行派发——同一批对象常落在同一个目录甚至
   同一个文件里，并行会互相覆盖。

规范 §19 已知限制（重命名等价于删除重建、snapshot pull db 连生产库、
tables 只声明列名、代码不计算哈希、并发协作未定义、以编译为门禁）在本实现中同样存在。
**并行开发暂不支持**：整个项目按波次推进，中途插入的需求要等下一轮，或用 git worktree 隔离。
