import fs from 'node:fs/promises';
import path from 'node:path';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
  [key: string]: unknown;
};

const inputPath = String(process.env.QA_BROWSER_FARM_INPUT_MANIFEST || '').trim();
const countsCsv = String(process.env.QA_BROWSER_FARM_SPLIT_COUNTS || '').trim();
const outputDir = String(process.env.QA_BROWSER_FARM_OUTPUT_DIR || '').trim();
const shardPrefix = String(process.env.QA_BROWSER_FARM_SHARD_PREFIX || 'shard').trim() || 'shard';

if (!inputPath || !countsCsv || !outputDir) {
  throw new Error('QA_BROWSER_FARM_INPUT_MANIFEST, QA_BROWSER_FARM_SPLIT_COUNTS, and QA_BROWSER_FARM_OUTPUT_DIR are required.');
}

const counts = countsCsv
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);

if (!counts.length) {
  throw new Error(`No valid shard counts were provided: ${countsCsv}`);
}

const selectUsersEvenly = <T>(users: T[], count: number) => {
  if (count >= users.length) {
    return users.slice(0, count);
  }
  if (count <= 1) {
    return users.slice(0, count);
  }

  const selected: T[] = [];
  const usedIndexes = new Set<number>();
  const maxIndex = users.length - 1;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const rawIndex = Math.round((ordinal * maxIndex) / (count - 1));
    let index = Math.max(0, Math.min(maxIndex, rawIndex));
    while (usedIndexes.has(index) && index < maxIndex) {
      index += 1;
    }
    while (usedIndexes.has(index) && index > 0) {
      index -= 1;
    }
    if (usedIndexes.has(index)) {
      continue;
    }
    usedIndexes.add(index);
    selected.push(users[index]);
  }

  if (selected.length === count) {
    return selected;
  }

  for (let index = 0; index < users.length && selected.length < count; index += 1) {
    if (usedIndexes.has(index)) {
      continue;
    }
    usedIndexes.add(index);
    selected.push(users[index]);
  }

  return selected;
};

const main = async () => {
  const users = JSON.parse(await fs.readFile(inputPath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(users) || !users.length) {
    throw new Error(`Prepared user manifest is empty: ${inputPath}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const totalRequested = counts.reduce((sum, count) => sum + count, 0);
  const selectedUsers = selectUsersEvenly(users, totalRequested);
  let cursor = 0;
  const outputs: Array<{ shardId: string; count: number; manifestPath: string }> = [];
  for (let shardIndex = 0; shardIndex < counts.length; shardIndex += 1) {
    const count = counts[shardIndex];
    const shardUsers = selectedUsers.slice(cursor, cursor + count).map((user, index) => ({
      ...user,
      shardId: `${shardPrefix}-${String(shardIndex + 1).padStart(2, '0')}`,
      index: Number.isFinite(Number(user.index)) ? Number(user.index) : cursor + index,
    }));
    cursor += count;
    const shardId = `${shardPrefix}-${String(shardIndex + 1).padStart(2, '0')}`;
    const manifestPath = path.join(outputDir, `${shardId}.json`);
    await fs.writeFile(manifestPath, `${JSON.stringify(shardUsers, null, 2)}\n`, 'utf8');
    outputs.push({ shardId, count: shardUsers.length, manifestPath });
  }

  process.stdout.write(`${JSON.stringify({ outputs }, null, 2)}\n`);
};

void main();
