#!/usr/bin/env bash
set -euo pipefail

QA_BASE_URL_VALUE="${1:-${QA_BASE_URL:-}}"
HEALTH_CHECK_REPEATS_VALUE="${HEALTH_CHECK_REPEATS:-3}"

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "Usage: $0 <https://app.staging-ip.nip.io>" >&2
  exit 1
fi

node - "${QA_BASE_URL_VALUE}" "${HEALTH_CHECK_REPEATS_VALUE}" <<'NODE'
const baseUrl = process.argv[2];
const repeats = Math.max(1, Number(process.argv[3] || '3'));

const fetchText = async (url) => {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'edumaster-staging-health-check/1.0',
    },
  });
  const text = await response.text();
  return { response, text };
};

const main = async () => {
  let expectedBundle = '';
  for (let attempt = 1; attempt <= repeats; attempt += 1) {
    const { response, text } = await fetchText(`${baseUrl}/`);
    if (!response.ok) {
      throw new Error(`root returned ${response.status} on attempt ${attempt}`);
    }
    const bundleMatch = text.match(/\/assets\/index-[^"' ]+\.js/);
    if (!bundleMatch) {
      throw new Error(`root did not include an entry bundle on attempt ${attempt}`);
    }
    const bundle = bundleMatch[0];
    if (expectedBundle && bundle !== expectedBundle) {
      throw new Error(`inconsistent entry bundle hash: ${expectedBundle} vs ${bundle}`);
    }
    expectedBundle = bundle;
    console.log(`[staging-health] root ok attempt=${attempt} bundle=${bundle}`);
  }

  for (const path of ['/backend/api/live', '/backend/api/ready', '/backend/api/health']) {
    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const { response } = await fetchText(`${baseUrl}${path}`);
      if (!response.ok) {
        throw new Error(`${path} returned ${response.status} on attempt ${attempt}`);
      }
      console.log(`[staging-health] ${path} ok attempt=${attempt} status=${response.status}`);
    }
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
NODE
