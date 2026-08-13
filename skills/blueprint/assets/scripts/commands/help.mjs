import { out } from '../runtime/cli.mjs';
import { BP_VERSION } from '../lib/version.mjs';

export function run() {
  out(`blueprint v${BP_VERSION}

  bp stage [--json]                     全项目当前 stage 与该调的 skill
  bp scan [product|flow|activity|domain|code] [--all] [--json]
                                        某一层的待办清单;不带层名为总览

  bp review ask <id> --q "<问题>"        提一个澄清问题,返回编号
  bp review answer <id> <Qn> --a "<答复>" 记录人的答复
  bp review resolve <id> <Qn> --note "<落点>"  记录落在文档的什么位置
  bp review list <id> [--json]          列出澄清记录

  bp flow changes <flow>                打印待确认的流程与活动编排
  bp flow approve <flow>                确认并盖章
  bp activity changes <service>         打印活动文档变更(含被哪些流程编排)
  bp activity approve <service>         确认并盖章
  bp domain list                        全部领域能力及状态
  bp domain changes <@id>               打印契约变更
  bp domain approve <@id>               确认并盖章
  bp domain reject <@id> --reason "…"   记录不提取的决定

  bp code check <id>                    记录实现前的预检
  bp code done <id>                     跑 verify,通过则记录实现
  bp code adopt <id>|--all              存量接入,跳过 verify

  bp commit context [--json]            本轮变更的结构化摘要
  bp commit message --summary "<文本>"   拼装完整提交信息

  bp status <id>                        单个对象详情
  bp scope <id>                         输出读取清单
  bp read <id>#<章节>                    输出章节纯文本
  bp validate [<id>]                    模板与引用校验
  bp schema pull                        导出全库到 snapshot
  bp schema check [<id>]                比对声明与 snapshot
  bp codemap validate <id>              检查文件均存在
  bp which <file>                       反查文件所属活动或能力
  bp verify [--scope <s>]               执行 config.verify
  bp delete plan <id>                   生成清理清单到 todo`);
}
