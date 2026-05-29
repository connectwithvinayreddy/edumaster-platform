const mongoose = require('mongoose');
const CourseSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 255 },
  category: { type: String, default: 'SSC JE' },
  exam: { type: String, default: 'SSC JE' },
  subject: { type: String, default: 'General' },
  level: { type: String, default: 'Full Course' },
  description: { type: String },
  price: { type: Number, default: 0 },
  offerPercentage: { type: Number, default: 0 },
  validityDays: { type: Number, default: 365 },
  thumbnailUrl: { type: String },
  instructor: { type: String },
  officialChannelUrl: { type: String },
  modules: { type: [Object], default: [] },
  createdBy: { type: String },
  created_at: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Course', CourseSchema);
