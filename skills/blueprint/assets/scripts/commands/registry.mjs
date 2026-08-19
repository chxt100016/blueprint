import { fail } from '../runtime/cli.mjs';
import { run as activityApprove } from './activity/approve.mjs';
import { run as activityChanges } from './activity/changes.mjs';
import { run as activityShow } from './activity/show.mjs';
import { run as codeCheck } from './code/check.mjs';
import { run as codeDone } from './code/done.mjs';
import { run as commitContext } from './commit/context.mjs';
import { run as commitMessage } from './commit/message.mjs';
import { run as deletePlan } from './delete/plan.mjs';
import { run as domainApprove } from './domain/approve.mjs';
import { run as domainChanges } from './domain/changes.mjs';
import { run as domainList } from './domain/list.mjs';
import { run as domainShow } from './domain/show.mjs';
import { run as flowApprove } from './flow/approve.mjs';
import { run as flowChanges } from './flow/changes.mjs';
import { run as flowShow } from './flow/show.mjs';
import { run as help } from './help.mjs';
import { run as newDoc } from './new.mjs';
import { run as reviewAnswer } from './review/answer.mjs';
import { run as reviewAsk } from './review/ask.mjs';
import { run as reviewResolve } from './review/resolve.mjs';
import { run as scan } from './scan.mjs';
import { run as scope } from './scope.mjs';
import { run as snapshotList } from './snapshot/list.mjs';
import { run as snapshotPull } from './snapshot/pull.mjs';
import { run as snapshotShow } from './snapshot/show.mjs';
import { run as stage } from './stage.mjs';
import { run as todoPath } from './todo/path.mjs';
import { run as validate } from './validate.mjs';

const COMMANDS = new Map([
  ['stage', stage],
  ['scan', scan],
  ['new', newDoc],
  ['scope', scope],
  ['validate', validate],
  ['review ask', reviewAsk],
  ['review answer', reviewAnswer],
  ['review resolve', reviewResolve],
  ['flow changes', flowChanges],
  ['flow approve', flowApprove],
  // 子命令在 dispatch 里优先匹配,落不到的就是 id:`bp flow <id>` / `bp activity <id>`
  ['flow', flowShow],
  ['activity changes', activityChanges],
  ['activity approve', activityApprove],
  ['activity', activityShow],
  ['domain list', domainList],
  ['domain show', domainShow],
  ['domain changes', domainChanges],
  ['domain approve', domainApprove],
  ['code check', codeCheck],
  ['code done', codeDone],
  ['commit context', commitContext],
  ['commit message', commitMessage],
  ['snapshot pull', snapshotPull],
  ['snapshot list', snapshotList],
  ['snapshot show', snapshotShow],
  ['delete plan', deletePlan],
  ['todo path', todoPath],
  ['help', help],
]);

const GROUP_USAGE = new Map([
  ['review', '用法: bp review ask|answer|resolve <id>'],
  ['domain', '用法: bp domain list|show|changes|approve'],
  ['code', '用法: bp code check|done <id>'],
  ['commit', '用法: bp commit context|message'],
  ['snapshot', '用法: bp snapshot pull|list|show <db|rpc> [范围]'],
  ['delete', '用法: bp delete plan <id>'],
  ['todo', '用法: bp todo path <id> <migration|manual>'],
]);

export function dispatch(cli) {
  const [command, subcommand] = cli.args;
  if (command === undefined || command === '--help' || command === '-h') return help(cli, []);
  if (command === 'init') return fail('init 属于母版，请运行 blueprint skill 包内的 bootstrap.mjs');

  const nested = subcommand ? `${command} ${subcommand}` : null;
  if (nested && COMMANDS.has(nested)) return COMMANDS.get(nested)(cli, cli.args.slice(2));
  if (COMMANDS.has(command)) return COMMANDS.get(command)(cli, cli.args.slice(1));
  if (GROUP_USAGE.has(command)) return fail(GROUP_USAGE.get(command));
  return fail(`未知命令: ${command}\n运行 bp help 查看全部命令`);
}
