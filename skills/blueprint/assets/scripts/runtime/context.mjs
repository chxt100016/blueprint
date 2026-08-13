import { execFileSync } from 'node:child_process';

import { findRoot, loadConfig } from '../lib/config.mjs';
import { loadRepo } from '../lib/repo.mjs';
import { fail } from './cli.mjs';

export function rootOrDie(cli) {
  const root = findRoot(cli.option('root', process.cwd()));
  if (!root) fail('未找到 blueprint/config.yaml。先运行 blueprint skill 的 init。');
  return root;
}

export function ctx(cli) {
  const root = rootOrDie(cli);
  const cfg = loadConfig(root);
  return { root, cfg, repo: loadRepo(root, cfg) };
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

export function baseCommit(root) {
  return git(root, ['rev-parse', 'HEAD']);
}
