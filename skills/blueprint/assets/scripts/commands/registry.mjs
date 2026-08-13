import { fail } from '../runtime/cli.mjs';
import { run as activityApprove } from './activity/approve.mjs';
import { run as activityChanges } from './activity/changes.mjs';
import { run as codeAdopt } from './code/adopt.mjs';
import { run as codeCheck } from './code/check.mjs';
import { run as codeDone } from './code/done.mjs';
import { run as codemapValidate } from './codemap/validate.mjs';
import { run as commitContext } from './commit/context.mjs';
import { run as commitMessage } from './commit/message.mjs';
import { run as deletePlan } from './delete/plan.mjs';
import { run as domainApprove } from './domain/approve.mjs';
import { run as domainChanges } from './domain/changes.mjs';
import { run as domainList } from './domain/list.mjs';
import { run as domainReject } from './domain/reject.mjs';
import { run as flowApprove } from './flow/approve.mjs';
import { run as flowChanges } from './flow/changes.mjs';
import { run as help } from './help.mjs';
import { run as read } from './read.mjs';
import { run as reviewAnswer } from './review/answer.mjs';
import { run as reviewAsk } from './review/ask.mjs';
import { run as reviewList } from './review/list.mjs';
import { run as reviewResolve } from './review/resolve.mjs';
import { run as scan } from './scan.mjs';
import { run as schemaCheck } from './schema/check.mjs';
import { run as schemaPull } from './schema/pull.mjs';
import { run as scope } from './scope.mjs';
import { run as stage } from './stage.mjs';
import { run as status } from './status.mjs';
import { run as validate } from './validate.mjs';
import { run as verify } from './verify.mjs';
import { run as which } from './which.mjs';

const COMMANDS = new Map([
  ['stage', stage],
  ['scan', scan],
  ['status', status],
  ['scope', scope],
  ['read', read],
  ['validate', validate],
  ['review ask', reviewAsk],
  ['review answer', reviewAnswer],
  ['review resolve', reviewResolve],
  ['review list', reviewList],
  ['flow changes', flowChanges],
  ['flow approve', flowApprove],
  ['activity changes', activityChanges],
  ['activity approve', activityApprove],
  ['domain list', domainList],
  ['domain changes', domainChanges],
  ['domain approve', domainApprove],
  ['domain reject', domainReject],
  ['code check', codeCheck],
  ['code done', codeDone],
  ['code adopt', codeAdopt],
  ['commit context', commitContext],
  ['commit message', commitMessage],
  ['schema pull', schemaPull],
  ['schema check', schemaCheck],
  ['codemap validate', codemapValidate],
  ['which', which],
  ['verify', verify],
  ['delete plan', deletePlan],
  ['help', help],
]);

const GROUP_USAGE = new Map([
  ['review', '用法: bp review ask|answer|resolve|list <id>'],
  ['flow', '用法: bp flow changes|approve <flow>'],
  ['activity', '用法: bp activity changes|approve <service>'],
  ['domain', '用法: bp domain list|changes|approve|reject'],
  ['code', '用法: bp code check|done|adopt <id>'],
  ['commit', '用法: bp commit context|message'],
  ['schema', '用法: bp schema pull|check'],
  ['codemap', '用法: bp codemap validate <id>'],
  ['delete', '用法: bp delete plan <id>'],
]);

export function dispatch(cli) {
  const [command, subcommand] = cli.args;
  if (command === undefined || command === '--help' || command === '-h') return help(cli, []);
  if (command === 'init') return fail('init 属于母版，请运行 blueprint skill 包内的 assets/bootstrap.mjs');

  const nested = subcommand ? `${command} ${subcommand}` : null;
  if (nested && COMMANDS.has(nested)) return COMMANDS.get(nested)(cli, cli.args.slice(2));
  if (COMMANDS.has(command)) return COMMANDS.get(command)(cli, cli.args.slice(1));
  if (GROUP_USAGE.has(command)) return fail(GROUP_USAGE.get(command));
  return fail(`未知命令: ${command}\n运行 bp help 查看全部命令`);
}
