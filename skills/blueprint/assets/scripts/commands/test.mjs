// 流程的失败路径与测试用例的对照表。
//
// 写用例之前跑它拿失败路径清单当底稿,写完之后跑它看覆盖缺口——同一张表回答两个问题,
// 所以缺口以 `(缺用例)` 留在表里,不单独做成一份报错清单。
//
// 映射本身不由脚本推导:哪条用例盖哪条失败路径,是用例标题里 `[E1]` 声明的。
// 脚本只做集合比对——声明的编号存不存在、每条失败路径有没有人认领。
// 「这条用例是不是真在测它」属于语义,只有人在确认时看得出来。
//
// 这是 test 层唯一的脚本判定:用例文档不进 lock、不算哈希、不记实现。
import path from 'node:path';

import { findSection, parseFrontMatter, parseRuleRows, readFileSafe, splitSections } from '../lib/parse.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { clip, table } from '../runtime/format.mjs';

const SUCCESS = '成功';

/** 异常分支多半写成表格,竖线换成空格才排得进对照表。 */
function exceptionRows(body) {
  if (body === '无') return [];
  return parseRuleRows(body, 'E').map((r) => ({
    id: `E${r.no}`,
    text: r.text.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

/** 用例标题:`### T3 [E1] 库存不足`。标记缺失时 marks 为空,由调用方报出来。 */
function caseRows(body) {
  return parseRuleRows(body, 'T').map((r) => {
    const m = r.text.match(/^\[([^\]]*)\]\s*(.*)$/);
    return {
      id: `T${r.no}`,
      no: r.no,
      marks: (m ? m[1] : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      text: m ? m[2].trim() : r.text,
    };
  });
}

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  if (!id) fail('用法: bp test <flowId>');
  const flow = repo.flows.get(id);
  if (!flow) fail(`找不到流程 ${id}`);

  const file = flow.file.replace(/\.md$/, '.testcase.md');
  const rel = path.relative(root, file);
  const raw = readFileSafe(file);

  const exceptions = exceptionRows((findSection(flow.sections, '异常分支')?.body || '').trim());
  const summary = (findSection(flow.sections, '概要')?.body || '').trim();

  out(`${id}  ${clip(summary, 40)}`);
  out(`用例  ${rel}${raw === null ? '  (还没有)' : ''}`);

  let cases = [];
  if (raw !== null) {
    const { sections } = splitSections(parseFrontMatter(raw).body);
    const section = findSection(sections, '用例');
    if (!section) fail(`${rel} 里没有「用例」这一节`);
    cases = caseRows(section.body);
  }

  const problems = [];
  const covers = new Map(exceptions.map((e) => [e.id, []]));
  let success = 0;

  for (const c of cases) {
    if (!c.marks.length) {
      problems.push(`${c.id} 没有覆盖标记,编号后要跟 \`[${SUCCESS}]\` 或它覆盖的失败码编号 \`[E1]\``);
      continue;
    }
    for (const mark of c.marks) {
      if (mark === SUCCESS) { success++; continue; }
      if (!covers.has(mark)) {
        problems.push(`${c.id} 声明覆盖 ${mark},但「异常分支」里没有这一条`);
        continue;
      }
      covers.get(mark).push(c.id);
    }
  }

  for (let i = 0; i < cases.length; i++) {
    if (cases[i].no !== i + 1) {
      problems.push(`用例编号应从 1 连续递增,第 ${i + 1} 条为 ${cases[i].id}`);
      break;
    }
  }

  if (exceptions.length) {
    out('');
    out('异常分支 → 用例');
    table(exceptions.map((e) => [`  ${e.id}`, clip(e.text, 46), covers.get(e.id).join(' ') || '(缺用例)']));
    const missing = exceptions.filter((e) => !covers.get(e.id).length);
    if (missing.length) {
      problems.push(`${missing.map((e) => e.id).join(', ')} 没有任何用例覆盖,「异常分支」每条失败路径都要有用例`);
    }
  }

  if (cases.length) {
    out('');
    out('用例 → 覆盖');
    table(cases.map((c) => [`  ${c.id}`, clip(c.text, 46), c.marks.join(' ') || '(缺标记)']));
  }

  if (!success) problems.push(`没有 \`[${SUCCESS}]\` 用例——至少要有一条走通全链的最小成功路径`);

  const covered = exceptions.filter((e) => covers.get(e.id).length).length;
  out('');
  out(`${exceptions.length} 条异常分支,${covered} 条已覆盖;${cases.length} 条用例,含 ${success} 条成功用例`);

  if (problems.length) {
    out('');
    out('问题');
    for (const p of problems) out(`  - ${p}`);
    process.exit(1);
  }
}
