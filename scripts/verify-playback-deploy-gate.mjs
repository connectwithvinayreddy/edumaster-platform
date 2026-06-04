import fs from 'node:fs';
import path from 'node:path';

const summaryPath = String(process.env.PLAYBACK_DEPLOY_GATE_SUMMARY || process.argv[2] || '').trim();
const requiredStage = Number(process.env.PLAYBACK_DEPLOY_REQUIRED_STAGE || process.argv[3] || 2000);
const manualApproval = String(process.env.PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL || '').trim().toLowerCase();

if (!summaryPath) {
  throw new Error('PLAYBACK_DEPLOY_GATE_SUMMARY is required.');
}

if (!fs.existsSync(summaryPath)) {
  throw new Error(`Playback deploy gate summary not found: ${summaryPath}`);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const approved = ['1', 'true', 'yes', 'approved', 'confirm', 'confirmed'].includes(manualApproval);
const exactRealBrowserCount = Number(summary.exactRealBrowserCount || 0);
const exactSyntheticDiagnosticCount = Number(summary.exactSyntheticDiagnosticCount || 0);
const requiredStagePassed = Boolean(summary.requiredStagePassed);
const eligibleForManualProductionApproval = Boolean(summary.eligibleForManualProductionApproval);
const allUsersRealBrowsers = summary.allUsersRealBrowsers !== false;
const blockingFailures = Array.isArray(summary.blockingFailures) ? summary.blockingFailures : [];

const problems = [];
if (!eligibleForManualProductionApproval) {
  problems.push('summary_not_eligible_for_manual_production_approval');
}
if (!requiredStagePassed) {
  problems.push(`required_stage_${requiredStage}_not_passed`);
}
if (exactRealBrowserCount < requiredStage) {
  problems.push(`exact_real_browser_count_below_${requiredStage}`);
}
if (!allUsersRealBrowsers) {
  problems.push('summary_is_not_all_real_browser_users');
}
if (exactSyntheticDiagnosticCount > 0) {
  problems.push('synthetic_diagnostic_users_present');
}
if (blockingFailures.length > 0) {
  problems.push(...blockingFailures.map((entry) => `blocking_failure:${entry}`));
}
if (!approved) {
  problems.push('manual_approval_missing');
}

const verdict = {
  ok: problems.length === 0,
  summaryPath: path.resolve(summaryPath),
  requiredStage,
  exactRealBrowserCount,
  exactSyntheticDiagnosticCount,
  requiredStagePassed,
  eligibleForManualProductionApproval,
  manualApprovalProvided: approved,
  allUsersRealBrowsers,
  blockingFailures,
  problems,
};

process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);

if (!verdict.ok) {
  process.exit(1);
}
