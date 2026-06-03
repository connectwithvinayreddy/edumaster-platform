import fs from 'node:fs/promises';
import path from 'node:path';
import { createRunContext, writeJson, writeText } from './utils.js';

type IssueSeverity = 'Critical' | 'High' | 'Medium' | 'Low';
type IssueType = 'Functional' | 'Data' | 'Payment' | 'Performance' | 'UI' | 'Button' | 'Refresh' | 'Security' | 'Automation gap' | 'Infra';

type IssueRecord = {
  issueId: string;
  artifactPath: string;
  screenshotPath?: string | null;
  logLine?: string | null;
  severity: IssueSeverity;
  type: IssueType;
  rootCause: string;
  fixRequired: string;
  fixed: 'fixed' | 'pending';
  blocks500Stage: boolean;
};

const rootDir = path.resolve(process.cwd());
const artifactBase = path.join(rootDir, 'qa-automation', 'artifacts');
const reportsBase = path.join(rootDir, 'qa-automation', 'reports');

const readJson = async <T>(filePath: string) => JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
const fileExists = async (filePath: string) => fs.access(filePath).then(() => true).catch(() => false);

const main = async () => {
  const ctx = await createRunContext();
  const issues: IssueRecord[] = [];

  const paymentAuditPath = path.join(artifactBase, '2026-05-31T19-01-38-716Z', 'payment-count-reconciliation-audit-summary.json');
  const active100Path = path.join(artifactBase, '2026-05-31T18-05-48-429Z', 'active-100-certification-summary.json');
  const adminSmokePath = path.join(artifactBase, '2026-05-31T19-01-17-849Z', 'admin-tab-smoke-summary.json');
  const overviewSummaryPath = path.join(artifactBase, '2026-05-31T18-52-46-731Z', 'analysis', 'summary.json');
  const fullscreenPath = path.join(artifactBase, '2026-05-31T19-01-17-910Z', 'analysis', 'course-player-fullscreen-mobile-review.json');
  const fullscreenFailurePath = path.join(artifactBase, '2026-05-31T18-57-49-395Z', 'analysis', 'course-player-fullscreen-mobile-review-failure.json');
  const paymentControlPath = path.join(artifactBase, '2026-05-31T18-05-12-827Z', 'payment-admin-control-center-summary.json');
  const phase2LoadPath = path.join(reportsBase, 'phase2-student-load-2026-05-31T18-07-10-787Z', 'full-automation-test-report.json');
  const deployMonitorPath = path.join(ctx.analysisDir, 'deploy-monitor-transient-525.txt');

  const paymentAudit = await readJson<any>(paymentAuditPath);
  const active100 = await readJson<any>(active100Path);
  const adminSmoke = await readJson<any>(adminSmokePath);
  const overviewSummary = await readJson<any>(overviewSummaryPath);
  const fullscreen = await readJson<any>(fullscreenPath);
  const fullscreenFailure = await readJson<any>(fullscreenFailurePath);
  const paymentControl = await readJson<any>(paymentControlPath);
  const phase2Load = await readJson<any>(phase2LoadPath);

  await writeText(deployMonitorPath, '2026-05-31T18:58:05Z 525 https://app.varonenglishapp.in/backend/api/live');

  if ((paymentAudit.reconciliation?.cards?.localSuccessButNotVerifiedInRazorpay || 0) > 0) {
    issues.push({
      issueId: 'PAY-001',
      artifactPath: paymentAuditPath,
      screenshotPath: paymentAudit.screenshots?.adminOverviewAfterFix || null,
      logLine: `localSuccessButNotVerifiedInRazorpay=${paymentAudit.reconciliation.cards.localSuccessButNotVerifiedInRazorpay}`,
      severity: 'High',
      type: 'Payment',
      rootCause: 'Historical local paid rows are missing strict Razorpay verification metadata.',
      fixRequired: 'Keep these rows separate, provide dry-run reconciliation, and repair only via safe verified sync paths.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if ((paymentAudit.reconciliation?.cards?.differenceCount || 0) !== 0) {
    issues.push({
      issueId: 'PAY-002',
      artifactPath: paymentAuditPath,
      screenshotPath: paymentAudit.screenshots?.adminOverviewAfterFix || null,
      logLine: `differenceCount=${paymentAudit.reconciliation.cards.differenceCount}`,
      severity: 'Critical',
      type: 'Payment',
      rootCause: 'Admin captured-payment count diverged from Razorpay for the selected audited range.',
      fixRequired: 'Do not proceed until counts match exactly for the same range, mode, currency, and merchant.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if ((paymentAudit.reconciliation?.wrongDateTimezoneRecords || paymentAudit.extraLocalRows || []).length > 0) {
    issues.push({
      issueId: 'PAY-003',
      artifactPath: paymentAuditPath,
      screenshotPath: paymentAudit.screenshots?.adminOverviewAfterFix || null,
      logLine: `wrongDateTimezoneRecords=${paymentAudit.reconciliation?.wrongDateTimezoneRecords?.length || paymentAudit.extraLocalRows?.length || 0}`,
      severity: 'Medium',
      type: 'Data',
      rootCause: 'Legacy local paid rows outside the selected range previously inflated all-time-style counts.',
      fixRequired: 'Keep explicit wrong-date/outside-range reporting in reconciliation and preserve custom range on refresh.',
      fixed: 'fixed',
      blocks500Stage: false,
    });
  }

  if (active100.result !== 'passed') {
    issues.push({
      issueId: 'AUTO-001',
      artifactPath: active100Path,
      screenshotPath: null,
      logLine: `failedScripts=${JSON.stringify(active100.failedScripts || [])}`,
      severity: 'High',
      type: 'Automation gap',
      rootCause: 'The active-100 certification wrapper captured stale failing child runs and exited with multiple automation failures.',
      fixRequired: 'Rerun certification only after harness defaults, admin smoke, overview smoke, and payment-control smoke are green.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if ((phase2Load.failedRequests || 0) > 0 || (phase2Load.progress?.successfulJourneys || 0) !== 100) {
    issues.push({
      issueId: 'LOAD-001',
      artifactPath: phase2LoadPath,
      screenshotPath: null,
      logLine: `successfulJourneys=${phase2Load.progress?.successfulJourneys || 0}, failedRequests=${phase2Load.failedRequests || 0}, error=${phase2Load.error || 'none'}`,
      severity: 'High',
      type: 'Performance',
      rootCause: 'The latest 100-user student load run aborted after a transient request failure instead of completing with full success.',
      fixRequired: 'Harden transient GET retry behavior and keep the run alive long enough to produce a complete failure distribution.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if ((adminSmoke.consoleErrors || []).length > 0 || (adminSmoke.networkErrors || []).length > 0 || (adminSmoke.pageErrors || []).length > 0) {
    issues.push({
      issueId: 'UI-001',
      artifactPath: adminSmokePath,
      screenshotPath: adminSmoke.screenshots?.afterClick || null,
      logLine: `consoleErrors=${(adminSmoke.consoleErrors || []).length}, networkErrors=${(adminSmoke.networkErrors || []).length}, pageErrors=${(adminSmoke.pageErrors || []).length}`,
      severity: 'High',
      type: 'UI',
      rootCause: 'Admin tab smoke captured runtime or network failures.',
      fixRequired: 'Fix console/page/network errors before the next regression pass.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if (adminSmoke.adminEmail !== 'admin@varonenglishapp.in') {
    issues.push({
      issueId: 'AUTO-002',
      artifactPath: adminSmokePath,
      screenshotPath: adminSmoke.screenshots?.afterClick || null,
      logLine: `adminEmail=${adminSmoke.adminEmail}`,
      severity: 'Medium',
      type: 'Automation gap',
      rootCause: 'Admin smoke used an outdated default admin credential label in the artifact.',
      fixRequired: 'Correct the default admin credential fallback in the smoke harness.',
      fixed: 'fixed',
      blocks500Stage: false,
    });
  }

  if ((overviewSummary.failures || []).length > 0) {
    issues.push({
      issueId: 'UI-002',
      artifactPath: overviewSummaryPath,
      screenshotPath: overviewSummary.captures?.[0]?.screenshotPath || null,
      logLine: `failures=${(overviewSummary.failures || []).length}`,
      severity: 'Medium',
      type: 'Refresh',
      rootCause: 'Overview browser review reported failures.',
      fixRequired: 'Stabilize overview page load/refresh behavior before scaling.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  if (fullscreen.ok !== true) {
    issues.push({
      issueId: 'UI-003',
      artifactPath: fullscreenPath,
      screenshotPath: fullscreen.screenshots?.fullscreen || null,
      logLine: 'fullscreen review did not pass',
      severity: 'Medium',
      type: 'UI',
      rootCause: 'The latest fullscreen/mobile player review did not pass.',
      fixRequired: 'Do not regress player fullscreen/mobile behavior while payment/admin work is in progress.',
      fixed: 'pending',
      blocks500Stage: false,
    });
  }

  if (fullscreenFailure.ok === false) {
    issues.push({
      issueId: 'AUTO-003',
      artifactPath: fullscreenFailurePath,
      screenshotPath: path.join(path.dirname(path.dirname(fullscreenFailurePath)), 'screenshots', 'course-player-review-fullscreen.png'),
      logLine: fullscreenFailure.message || null,
      severity: 'Medium',
      type: 'Automation gap',
      rootCause: 'Fullscreen review was flaky before the latest successful rerun because the player selector did not become available in time.',
      fixRequired: 'Keep the latest stable fullscreen harness and avoid reusing stale failed artifacts as current proof.',
      fixed: 'fixed',
      blocks500Stage: false,
    });
  }

  if ((paymentControl.systemHealth?.appReplica1Health || 'unknown') === 'unknown' || (paymentControl.systemHealth?.appReplica2Health || 'unknown') === 'unknown') {
    issues.push({
      issueId: 'INFRA-001',
      artifactPath: paymentControlPath,
      screenshotPath: paymentControl.screenshots?.systemHealth || null,
      logLine: `replica1=${paymentControl.systemHealth?.appReplica1Health || 'unknown'}, replica2=${paymentControl.systemHealth?.appReplica2Health || 'unknown'}`,
      severity: 'Medium',
      type: 'Infra',
      rootCause: 'System Health does not yet expose per-replica health states in the admin UI/API.',
      fixRequired: 'Add replica-aware health instrumentation or clearly label the metric as unavailable in automation reports.',
      fixed: 'pending',
      blocks500Stage: false,
    });
  }

  issues.push({
    issueId: 'INFRA-002',
    artifactPath: deployMonitorPath,
    screenshotPath: null,
    logLine: '2026-05-31T18:58:05Z 525 https://app.varonenglishapp.in/backend/api/live',
    severity: 'Medium',
    type: 'Infra',
    rootCause: 'The hardened rolling deploy still exposed one transient edge handshake failure during cutover.',
    fixRequired: 'Investigate Caddy/Cloudflare TLS behavior during drain/reload and prove no repeated 525 before higher load stages.',
    fixed: 'pending',
    blocks500Stage: false,
  });

  if (!await fileExists(path.join(artifactBase, '2026-05-31T19-01-38-716Z', 'logs', 'backend.log'))) {
    issues.push({
      issueId: 'AUTO-004',
      artifactPath: paymentAuditPath,
      screenshotPath: paymentAudit.screenshots?.adminOverviewAfterFix || null,
      logLine: 'Expected backend.log missing from latest after-fix artifact set.',
      severity: 'Medium',
      type: 'Automation gap',
      rootCause: 'Latest after-fix artifact bundle is not yet complete for every required log family.',
      fixRequired: 'Capture backend, Caddy, browser console, network, DB, and health artifacts in the same run bundle.',
      fixed: 'pending',
      blocks500Stage: true,
    });
  }

  const summary = {
    reviewedArtifacts: {
      paymentAuditPath,
      active100Path,
      adminSmokePath,
      overviewSummaryPath,
      fullscreenPath,
      fullscreenFailurePath,
      paymentControlPath,
      phase2LoadPath,
    },
    issues,
    blockersFor500: issues.filter((issue) => issue.blocks500Stage).map((issue) => issue.issueId),
    issueCounts: {
      total: issues.length,
      critical: issues.filter((issue) => issue.severity === 'Critical').length,
      high: issues.filter((issue) => issue.severity === 'High').length,
      medium: issues.filter((issue) => issue.severity === 'Medium').length,
      low: issues.filter((issue) => issue.severity === 'Low').length,
    },
  };

  const summaryPath = path.join(ctx.rootDir, 'latest-payment-admin-artifact-review.json');
  const notesPath = path.join(ctx.rootDir, 'latest-payment-admin-artifact-review.md');
  await writeJson(summaryPath, summary);
  await writeText(notesPath, [
    '# Latest Payment/Admin Artifact Review',
    '',
    `Reviewed artifact groups: ${Object.keys(summary.reviewedArtifacts).length}`,
    `Total issues: ${summary.issueCounts.total}`,
    `500-stage blockers: ${summary.blockersFor500.join(', ') || 'none'}`,
    '',
    '| Issue ID | Severity | Type | Fixed | Blocks 500 | Root Cause |',
    '| --- | --- | --- | --- | --- | --- |',
    ...issues.map((issue) => `| ${issue.issueId} | ${issue.severity} | ${issue.type} | ${issue.fixed} | ${issue.blocks500Stage ? 'yes' : 'no'} | ${issue.rootCause.replace(/\|/g, '/')} |`),
  ].join('\n'));

  console.log(JSON.stringify({ summaryPath, notesPath, issueCount: issues.length, blockersFor500: summary.blockersFor500 }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
