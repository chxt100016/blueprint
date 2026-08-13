import { out } from './cli.mjs';

export function printErrors(errors) {
  const byWhere = new Map();
  for (const error of errors) {
    if (!byWhere.has(error.where)) byWhere.set(error.where, []);
    byWhere.get(error.where).push(error.msg);
  }
  for (const [where, messages] of byWhere) {
    out(where);
    for (const message of messages) out('  - ' + message);
  }
}
