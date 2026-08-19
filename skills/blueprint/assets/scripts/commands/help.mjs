import { out } from '../runtime/cli.mjs';
import { BP_VERSION } from '../lib/version.mjs';

export function run() {
  out(`blueprint v${BP_VERSION}

  bp stage                              全项目当前 stage 与该调的 skill
  bp scan <flow|activity|domain|code>   某一层的待办清单,只给 id 与状态
                                        详情用下面的 bp flow / bp activity 按 id 取

  bp new <id>                           按 id 建文档骨架,id 即路径:
                                          <cap>.<svc>                  service.md
                                          <cap>.<svc>.flow.<name>      业务流程(顺带建 service.md)
                                          <cap>.<svc>.activity.<name>  业务活动
                                          @<领域>.<name>               领域模型

  bp review ask <id> --q "<问题>"        提一个澄清问题,返回编号
  bp review answer <id> <Qn> --a "<答复>" 记录人的答复
  bp review resolve <id> <Qn> --note "<落点>"  记录落在文档的什么位置

  bp flow <service>                     该服务在 flow 层的全部上下文:
                                        业务描述全文 + service.md + 流程清单 + 活动池
  bp flow <flow>                        该流程文档的全文
  bp flow changes <service>|<flow>      打印本轮动了哪几个流程
  bp flow approve <flow> [<flow>...]    确认本轮改动的流程,必须列全(准出会比对)
  bp flow approve <service>             本轮无流程变更,只确认已读过新的业务描述

  bp activity <service>                 该服务在 activity 层的全部上下文:
                                        上游流程全文 + 活动清单(含编排与 uses)
  bp activity <activity>                该活动文档的全文
  bp activity changes <service>         打印活动文档变更(含被哪些流程编排)
  bp activity approve <service>         确认并盖章
  bp domain list                        全部领域模型及状态(聚合 / 领域服务)
  bp domain show <@id>                  该领域模型的全文
  bp domain changes <@id>               打印契约变更
  bp domain approve <@id>               确认并盖章

  bp code check <id>                    记录实现前的预检
  bp code done <id>                     跑 verify,通过则记录实现

  bp commit context                     本轮变更的结构化摘要
  bp commit message --summary "<文本>"   拼装完整提交信息

  bp scope <id>                         输出读取清单
  bp validate [<id>]                    模板与引用校验,含 tables 声明与 snapshot 的比对

  bp snapshot pull db                   导出全库结构到 snapshot
  bp snapshot pull rpc [<cap>[/<系统>]]  按 context/rpc 里的 curl 采样外部接口
  bp snapshot list <db|rpc> [<cap>]     快照清单(rpc 带概要)
  bp snapshot show db <表名>             打印建表语句
  bp snapshot show rpc <id>             打印某个接口的参数

  bp todo path <id> <migration|manual>  该建哪个工单文件(已存在的原样返回,时间戳不变)
  bp delete plan <id>                   生成清理清单到 todo`);
}
