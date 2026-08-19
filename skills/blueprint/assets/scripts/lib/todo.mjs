// 交人执行的工单。文件名承载它的全部元数据:
//
//   <14 位时间戳>_<归属对象 id>_<migration|manual>.md
//
// 归属 id 决定这份工单挡得住谁——scanCode 拿它与待实现的对象比对,对不上的工单
// 谁也挡不住,人还没处理完 code 层就照常派活。命名规则因此只留这一处,
// skill 不自己拼文件名,一律走 `bp todo path`。
import { bpPath } from './config.mjs';

export const TODO_KINDS = ['migration', 'manual'];

const NAME_RE = /^(\d{14})_(.+?)_(migration|manual)\.md$/;

/** 领域 id 的 `@` 保留:文件名里它合法,换成别的写法反而要多一套还原规则。 */
function encodeOwner(id) {
  return String(id).replace(/[^\w.@-]/g, '-');
}

/** `at-` 是早期的 `@` 写法,已经躺在盘上的工单还得认。 */
function decodeOwner(raw) {
  return raw.startsWith('at-') ? `@${raw.slice(3)}` : raw;
}

export function timestamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 不合命名规则的文件返回 null:它不是工单,不该挡住任何人。 */
export function parseTodoName(name) {
  const m = String(name).match(NAME_RE);
  if (!m) return null;
  return { ts: m[1], owner: decodeOwner(m[2]), kind: m[3] };
}

export function todoPath(root, id, kind, ts = timestamp()) {
  return bpPath(root, 'todo', `${ts}_${encodeOwner(id)}_${kind}.md`);
}
