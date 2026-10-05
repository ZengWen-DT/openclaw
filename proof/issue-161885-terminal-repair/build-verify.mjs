// Keep every canonical full-build step, bounding only supported tsdown concurrency.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { resolveBuildAllSteps, runBuildAllSteps } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/build-all.mts')).href
);
const { withDistArtifactOwnership } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/lib/dist-artifact-ownership.mts')).href
);
const steps = resolveBuildAllSteps('full', process.env).map((step) =>
  step.kind !== 'pnpm' && step.args.includes('scripts/tsdown-build.mts')
    ? { ...step, args: [...step.args, '--concurrency', '1'] }
    : step,
);
const result = await withDistArtifactOwnership(process.cwd(), () => runBuildAllSteps('full', { steps }));
process.exitCode = result.exitCode;
