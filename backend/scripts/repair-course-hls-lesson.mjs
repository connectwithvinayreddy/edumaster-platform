import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectDatabase } = require('../lib/database.js');
const { repairCourseLessonHlsOutputs } = require('../lib/video-processing.js');

const COURSE_ID = String(process.env.HLS_REPAIR_COURSE_ID || '').trim();
const LESSON_ID = String(process.env.HLS_REPAIR_LESSON_ID || '').trim();

const main = async () => {
  if (!COURSE_ID || !LESSON_ID) {
    throw new Error('HLS_REPAIR_COURSE_ID and HLS_REPAIR_LESSON_ID are required.');
  }

  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const result = await repairCourseLessonHlsOutputs({
    courseId: COURSE_ID,
    lessonId: LESSON_ID,
  });

  console.log(JSON.stringify({
    courseId: COURSE_ID,
    lessonId: LESSON_ID,
    ...result,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
