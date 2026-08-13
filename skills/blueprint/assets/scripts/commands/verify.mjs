import { ctx } from '../runtime/context.mjs';
import { runVerify } from '../runtime/verify.mjs';

export function run(cli) {
  const { root, cfg } = ctx(cli);
  const scope = cli.option('scope');
  const scopes = scope ? [scope] : Object.keys(cfg.verify);
  process.exit(runVerify(root, cfg, scopes) ? 0 : 1);
}
