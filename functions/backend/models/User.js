const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, maxlength: 100 },
  mobileNumber: { type: String, maxlength: 20 },
  password: { type: String, required: true, maxlength: 255 },
  role: { type: String, default: 'student' },
  device: { type: String },
  session: { type: String },
  streak: { type: Number, default: 0 },
  points: { type: Number, default: 0 },
  badges: { type: [Object], default: [] },
  referral_code: { type: String },
  created_at: { type: Date, default: Date.now }
});
module.exports = mongoose.model('User', UserSchema);
