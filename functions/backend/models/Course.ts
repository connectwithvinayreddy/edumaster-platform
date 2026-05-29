import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const LessonSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    type: { type: String, required: true, default: 'youtube' },
    durationMinutes: { type: Number, required: true, default: 0 },
    videoUrl: { type: String, default: null },
    notesUrl: { type: String, default: null },
    premium: { type: Boolean, default: false },
  },
  { _id: false },
);

const ModuleSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    lessons: { type: [LessonSchema], default: [] },
  },
  { _id: false },
);

export const CourseSchema = new Schema({
  title: { type: String, required: true, maxlength: 255 },
  category: { type: String, default: 'SSC JE' },
  exam: { type: String, default: 'SSC JE' },
  subject: { type: String, default: 'General' },
  level: { type: String, default: 'Full Course' },
  description: { type: String, default: '' },
  price: { type: Number, default: 0 },
  offerPercentage: { type: Number, default: 0 },
  validityDays: { type: Number, default: 365 },
  thumbnailUrl: { type: String, default: null },
  instructor: { type: String, default: 'VARONENGLISH Faculty' },
  officialChannelUrl: { type: String, default: null },
  modules: { type: [ModuleSchema], default: [] },
  createdBy: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
});

export type CourseDocument = InferSchemaType<typeof CourseSchema>;

export default mongoose.models.Course || mongoose.model('Course', CourseSchema);
