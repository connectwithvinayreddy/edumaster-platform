import fs from 'node:fs/promises';

const summaryPaths = String(process.env.QA_BROWSER_FARM_SUMMARY_PATHS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outputPath = String(process.env.QA_BROWSER_FARM_MERGED_OUTPUT || '').trim();
const mode = String(process.env.QA_BROWSER_FARM_MODE || 'video').trim();
const stage = Number(process.env.QA_BROWSER_FARM_STAGE || 0);

if (!summaryPaths.length || !outputPath) {
  throw new Error('QA_BROWSER_FARM_SUMMARY_PATHS and QA_BROWSER_FARM_MERGED_OUTPUT are required.');
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const main = async () => {
  const summaries = await Promise.all(summaryPaths.map(async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'))));
  const stages = summaries.flatMap((summary) => Array.isArray(summary.stages) ? summary.stages : []);
  const merged = {
    mode,
    stage,
    workerCount: summaries.length,
    ok: stages.length > 0 && stages.every((entry) => entry.ok),
    successCount: sum(stages.map((entry) => Number(entry.successCount || 0))),
    failureCount: sum(stages.map((entry) => Number(entry.failureCount || 0))),
    summaries: summaries.map((summary) => ({
      workerLabel: summary.workerLabel || null,
      shardId: summary.shardId || null,
      stages: summary.stages || [],
    })),
  } as Record<string, unknown>;

  if (mode === 'video') {
    const deliveryPathBreakdown = stages.reduce<Record<string, number>>((accumulator, entry) => {
      const values = entry.deliveryPathBreakdown || {};
      Object.entries(values).forEach(([key, value]) => {
        accumulator[key] = (accumulator[key] || 0) + Number(value || 0);
      });
      return accumulator;
    }, {});
    const failureBreakdown = stages.reduce<Record<string, number>>((accumulator, entry) => {
      const values = entry.failureBreakdown || {};
      Object.entries(values).forEach(([key, value]) => {
        accumulator[key] = (accumulator[key] || 0) + Number(value || 0);
      });
      return accumulator;
    }, {});
    merged.deliveryPathBreakdown = deliveryPathBreakdown;
    merged.failureBreakdown = failureBreakdown;
    merged.manifestFailures = sum(stages.map((entry) => Number(entry.manifestFailures || 0)));
    merged.segmentFailures = sum(stages.map((entry) => Number(entry.segmentFailures || 0)));
    merged.playbackConflicts = sum(stages.map((entry) => Number(entry.playbackConflicts || 0)));
  } else {
    const failureBreakdown = stages.reduce<Record<string, number>>((accumulator, entry) => {
      const values = entry.failureBreakdown || {};
      Object.entries(values).forEach(([key, value]) => {
        accumulator[key] = (accumulator[key] || 0) + Number(value || 0);
      });
      return accumulator;
    }, {});
    const journeyBreakdown = stages.reduce<Record<string, number>>((accumulator, entry) => {
      const values = entry.journeyBreakdown || {};
      Object.entries(values).forEach(([key, value]) => {
        accumulator[key] = (accumulator[key] || 0) + Number(value || 0);
      });
      return accumulator;
    }, {});
    merged.failureBreakdown = failureBreakdown;
    merged.journeyBreakdown = journeyBreakdown;
  }

  await fs.writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
};

void main();
