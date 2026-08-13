export const out = (s = '') => process.stdout.write(s + '\n');
export const errOut = (s = '') => process.stderr.write(s + '\n');

export function fail(msg, code = 1) {
  errOut(msg);
  process.exit(code);
}

export function createCli(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(`--${name}`);
  const option = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1 || i + 1 >= argv.length) return fallback;
    return argv[i + 1];
  };
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) i++;
      continue;
    }
    args.push(arg);
  }
  return { argv, args, flag, option };
}
