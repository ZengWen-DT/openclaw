import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('git', ['fetch', '--depth=1', 'https://github.com/openclaw/openclaw.git', 'dc5d61aadc026a7b3fac7b6db2f6bdc061ded071']);
run('git', ['checkout', '--force', '--detach', 'FETCH_HEAD']);
run('pnpm', ['install', '--frozen-lockfile']);
const path = 'src/gateway/openresponses-http.test.ts';
let source = readFileSync(path, 'utf8');
source = source.replace('import { resetConfigRuntimeState, type GatewayAuthConfig }', 'import { createSessionWorkStartChangedError } from "../config/sessions/work-start-error.js";\nimport { resetConfigRuntimeState, type GatewayAuthConfig }');
const start = source.indexOf('const STREAM_FAILURE_CASES = [');
const end = source.indexOf('] as const;', start);
if (start < 0 || end < 0) throw new Error('Regression insertion point missing');
source = source.slice(0, end) + `  {
    name: "a changed session conflict",
    createError: () => createSessionWorkStartChangedError("private-session-key"),
    tools: [],
    expectedCode: "invalid_request_error",
    expectedMessage: "Session changed while starting work",
  },\n` + source.slice(end);
writeFileSync(path, source);
run('node', ['scripts/run-vitest.mjs', 'run', 'src/gateway/openresponses-http.test.ts', '-t', 'changed session conflict']);
