import React, { useMemo, useState } from 'react';
import { Loader, Pencil, Save, Trash2, X } from 'lucide-react';
import { EduService } from '../EduService';
import { CourseCard } from '../types';

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const getDiscountedPrice = (price: number, offerPercentage: number) => {
  const safePrice = Math.max(Number(price || 0), 0);
  const safeOffer = Math.min(Math.max(Number(offerPercentage || 0), 0), 100);
  const discountedPrice = safePrice * (1 - (safeOffer / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 0);
};

interface AdminCourseManagerProps {
  courses: CourseCard[];
  onCoursesChanged?: () => void | Promise<void>;
}

const createForm = (course: CourseCard | null) => ({
  title: course?.title || '',
  description: course?.description || '',
  category: course?.category || 'SSC JE',
  exam: course?.exam || 'SSC JE',
  subject: course?.subject || '',
  instructor: course?.instructor || '',
  officialChannelUrl: course?.officialChannelUrl || '',
  price: Math.max(Number(course?.price || 0), 0),
  offerPercentage: Number(course?.offerPercentage || 0),
  validityDays: course?.validityDays || 183,
  level: course?.level || 'Full Course',
  thumbnailUrl: course?.thumbnailUrl || '',
});

export const AdminCourseManager: React.FC<AdminCourseManagerProps> = ({ courses, onCoursesChanged }) => {
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?._id || '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });
  const [form, setForm] = useState(createForm(courses[0] || null));

  const selectedCourse = useMemo(
    () => courses.find((course) => course._id === selectedCourseId) || null,
    [courses, selectedCourseId],
  );
  const totalTopics = useMemo(
    () => selectedCourse
      ? selectedCourse.modules.reduce((sum, module) => (
        sum
        + (module.lessons?.length || 0)
        + (module.chapters?.reduce((chapterSum, chapter) => chapterSum + (chapter.lessons?.length || 0), 0) || 0)
      ), 0)
      : 0,
    [selectedCourse],
  );

  const syncForm = (course: CourseCard | null) => {
    setForm(createForm(course));
  };

  const refresh = async () => {
    if (onCoursesChanged) {
      await onCoursesChanged();
    }
  };

  const handleSelect = (courseId: string) => {
    setSelectedCourseId(courseId);
    const nextCourse = courses.find((course) => course._id === courseId) || null;
    syncForm(nextCourse);
    setEditing(false);
    setMessage({ type: null, text: '' });
  };

  const handleSave = async () => {
    if (!selectedCourse) {
      return;
    }

    setBusy(true);
    try {
      await EduService.updateCourse(selectedCourse._id, {
        ...selectedCourse,
        ...form,
      });
      setEditing(false);
      setMessage({ type: 'success', text: 'Course updated successfully.' });
      await refresh();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to update course right now.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCourse) {
      return;
    }

    if (!window.confirm(`Delete "${selectedCourse.title}"? This removes the full course record.`)) {
      return;
    }

    setBusy(true);
    try {
      await EduService.deleteCourse(selectedCourse._id);
      const remaining = courses.filter((course) => course._id !== selectedCourse._id);
      setSelectedCourseId(remaining[0]?._id || '');
      syncForm(remaining[0] || null);
      setEditing(false);
      setMessage({ type: 'success', text: 'Course deleted successfully.' });
      await refresh();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to delete course right now.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
      <div>
        <h3 className="text-2xl font-semibold text-[var(--ink)]">Existing Course Manager</h3>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Review, edit, and delete live courses without leaving the admin workspace.
        </p>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-3">
          <label className="block text-sm font-semibold text-[var(--ink)]">Select existing course</label>
          <select
            value={selectedCourseId}
            onChange={(event) => handleSelect(event.target.value)}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          >
            <option value="">-- Choose a course --</option>
            {courses.map((course) => (
              <option key={course._id} value={course._id}>
                {course.title}
              </option>
            ))}
          </select>

          {selectedCourse && (
            <div className="rounded-[24px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink-soft)]">
              <p><span className="font-semibold text-[var(--ink)]">Exam:</span> {selectedCourse.exam}</p>
              <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Subjects:</span> {selectedCourse.modules.length}</p>
              <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Topics:</span> {selectedCourse.lessonCount || totalTopics}</p>
              <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Course fee:</span> {Number(selectedCourse.price || 0) === 0 ? 'Free' : currency.format(selectedCourse.price || 0)}</p>
              <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Offer:</span> {Number(selectedCourse.offerPercentage || 0)}%</p>
              <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Payable:</span> {Number(selectedCourse.price || 0) === 0 ? 'Free' : currency.format(getDiscountedPrice(selectedCourse.price || 0, selectedCourse.offerPercentage || 0))}</p>
            </div>
          )}
        </div>

        <div className="rounded-[24px] border border-[var(--line)] bg-white p-5">
          {selectedCourse ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-semibold text-[var(--ink)]">Course details</h4>
                <div className="flex flex-wrap gap-2">
                  {editing ? (
                    <>
                      <button
                        onClick={() => void handleSave()}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      >
                        {busy ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </button>
                      <button
                        onClick={() => {
                          syncForm(selectedCourse);
                          setEditing(false);
                        }}
                        className="flex items-center gap-2 rounded-xl border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink)]"
                      >
                        <X className="h-4 w-4" />
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setEditing(true)}
                        className="flex items-center gap-2 rounded-xl border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink)]"
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </button>
                      <button
                        onClick={() => void handleDelete()}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 disabled:opacity-60"
                      >
                        {busy ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Course Title</span>
                  <input value={form.title} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Subject</span>
                  <input value={form.subject} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Instructor</span>
                  <input value={form.instructor} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, instructor: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Official Channel URL</span>
                  <input value={form.officialChannelUrl} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, officialChannelUrl: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Course Fee (INR)</span>
                  <input type="number" min="0" value={form.price} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, price: Number(event.target.value) }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                  <span className="block text-xs text-[var(--ink-soft)]">Use `0` to keep the course free.</span>
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Offer Percentage</span>
                  <input type="number" min="0" max="100" value={form.offerPercentage} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, offerPercentage: Number(event.target.value) }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Validity (Days)</span>
                  <input type="number" min="1" value={form.validityDays} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, validityDays: Number(event.target.value) }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Category</span>
                  <input value={form.category} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Level</span>
                  <input value={form.level} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, level: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Exam</span>
                  <input value={form.exam} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, exam: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Thumbnail URL</span>
                  <input value={form.thumbnailUrl} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, thumbnailUrl: event.target.value }))} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="block text-sm font-semibold text-[var(--ink)]">Course Description</span>
                  <textarea value={form.description} disabled={!editing} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="h-32 w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none disabled:opacity-70" />
                </label>
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)] md:col-span-2">
                  Payable amount shown to learners: <span className="font-semibold text-[var(--ink)]">{form.price === 0 ? 'Free' : currency.format(getDiscountedPrice(form.price, form.offerPercentage))}</span>
                </div>
              </div>

              {message.type && (
                <div className={`rounded-2xl px-4 py-3 text-sm ${message.type === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-red-50 text-red-600'}`}>
                  {message.text}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-[22px] border border-dashed border-[var(--line)] p-6 text-center text-[var(--ink-soft)]">
              Select a course to edit pricing, curriculum metadata, and publishing details.
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
