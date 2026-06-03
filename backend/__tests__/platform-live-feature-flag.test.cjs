const test = require('node:test');
const assert = require('node:assert/strict');

const { appConfig } = require('../lib/config.js');
const { platformRepository } = require('../lib/repositories.js');
const { resetState } = require('../lib/store.js');

test('platform overview hides live classes when the feature flag is disabled', async (t) => {
  resetState({
    liveClasses: [
      {
        _id: 'live_1',
        title: 'Disabled feature regression check',
        startTime: '2026-05-31T10:00:00.000Z',
        durationMinutes: 60,
        status: 'scheduled',
        mode: 'live',
        instructor: 'Faculty',
        topicTags: [],
        resources: [],
        sessionNotes: [],
      },
    ],
  });

  const previousValue = appConfig.liveClassesEnabled;
  appConfig.liveClassesEnabled = false;

  t.after(() => {
    appConfig.liveClassesEnabled = previousValue;
    resetState({});
  });

  const overview = await platformRepository.getOverview(null);
  assert.deepEqual(overview.liveClasses, []);
  assert.equal(overview.adminOverview, null);
});
