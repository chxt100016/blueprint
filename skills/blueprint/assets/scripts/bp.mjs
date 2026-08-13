#!/usr/bin/env node
// blueprint 流水线的确定性判断由 commands/ 中的命令实现，统一在 registry.mjs 注册。

import { dispatch } from './commands/registry.mjs';
import { createCli, fail } from './runtime/cli.mjs';

function main() {
  const cli = createCli();
  try {
    return dispatch(cli);
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
}

main();
