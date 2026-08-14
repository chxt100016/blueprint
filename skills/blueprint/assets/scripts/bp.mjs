#!/usr/bin/env node
// blueprint 流水线的确定性判断由 commands/ 中的命令实现，统一在 registry.mjs 注册。

import { dispatch } from './commands/registry.mjs';
import { BpError } from './lib/error.mjs';
import { BP_VERSION } from './lib/version.mjs';
import { createCli, errOut, fail } from './runtime/cli.mjs';

// 脚本自身出错时的出口。**它必须与校验失败长得完全不一样**：
// 校验失败是「你的文档要改」，这里是「母版的代码有 bug，改文档没有用」。
// 两者共用一句话的话，AI 会把内部异常当成文档问题，一轮轮改文档去追一个不存在的错。
function crash(error) {
  errOut('');
  errOut('!! blueprint 脚本自身出错了 —— 这不是校验失败 !!');
  errOut('');
  errOut('你的文档没有问题，改文档不会让这个错误消失。');
  errOut('停下来把下面整段报给人，不要重试，不要绕开这条命令继续往下走。');
  errOut('');
  errOut(`blueprint v${BP_VERSION}  node ${process.version}  ${process.platform}`);
  errOut(`命令: bp ${process.argv.slice(2).join(' ')}`);
  errOut('');
  errOut(String(error?.stack || error));
  errOut('');
  // 70 = sysexits 的 EX_SOFTWARE(内部软件错误)。1 是一般失败、3 是校验不通过，
  // 三者分开，调用方不看文案也能区分。
  process.exit(70);
}

function main() {
  const cli = createCli();
  try {
    return dispatch(cli);
  } catch (error) {
    if (error instanceof BpError) return fail(error.message);
    crash(error);
  }
}

process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

main();
