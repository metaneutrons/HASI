import { runHealthyPluginContainerQualification, qualificationFailureCategory } from './healthy-plugin-qualification.js';

try {
  const summary = await runHealthyPluginContainerQualification();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.qualified !== true) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ qualified: false, blocker: qualificationFailureCategory(error) })}\n`);
  process.exitCode = 1;
}
