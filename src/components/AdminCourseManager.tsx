import React, { useEffect, useMemo, useState } from 'react';
import { Loader, Pencil, Save, Trash2, X } from 'lucide-react';
import { EduService } from '../EduService';
import { AdminCourseContentAccessRule, CourseCard, CourseLesson } from '../types';

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

type AdminLessonEntry = {
  moduleId: string;
  moduleTitle: string;
  chapterId: string | null;
  chapterTitle: string | null;
  lesson: CourseLesson;
};

const flattenLessonEntries = (course: CourseCard | null): AdminLessonEntry[] => (
  course?.modules.flatMap((module) => [
    ...(module.lessons || []).map((lesson) => ({
      moduleId: module.id,
      moduleTitle: module.title,
      chapterId: null,
      chapterTitle: null,
      lesson,
    })),
    ...((module.chapters || []).flatMap((chapter) => (
      (chapter.lessons || []).map((lesson) => ({
        moduleId: module.id,
        moduleTitle: module.title,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        lesson,
      }))
    ))),
  ]) || []
);

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
  const initialLessonEntries = flattenLessonEntries(courses[0] || null);
  const initialLesson = initialLessonEntries[0] || null;
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?._id || '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });
  const [form, setForm] = useState(createForm(courses[0] || null));
  const [selectedLessonId, setSelectedLessonId] = useState(initialLessonEntries[0]?.lesson.id || '');
  const [lessonBusy, setLessonBusy] = useState(false);
  const [lessonMessage, setLessonMessage] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });
  const [lessonForm, setLessonForm] = useState({
    watchLimit: Math.max(Number(initialLesson?.lesson.watchLimit || 2), 1),
    watchCompletionPercent: Math.min(Math.max(Number(initialLesson?.lesson.watchCompletionPercent || 90), 50), 100),
  });
  const [accessRules, setAccessRules] = useState<AdminCourseContentAccessRule[]>([]);
  const [accessRulesBusy, setAccessRulesBusy] = useState(false);
  const [accessRulesMessage, setAccessRulesMessage] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });
  const [ruleForm, setRuleForm] = useState({
    contentScope: 'course',
    access: 'block',
    chapterId: '',
    lessonId: '',
    adminNote: '',
  });

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
  const lessonEntries = useMemo<AdminLessonEntry[]>(
    () => flattenLessonEntries(selectedCourse),
    [selectedCourse],
  );
  const selectedLessonEntry = useMemo(
    () => lessonEntries.find((entry) => entry.lesson.id === selectedLessonId) || null,
    [lessonEntries, selectedLessonId],
  );
  const chapterEntries = useMemo(
    () => (selectedCourse?.modules || []).flatMap((module) => (module.chapters || []).map((chapter) => ({
      moduleId: module.id,
      moduleTitle: module.title,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
    }))),
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

  const loadAccessRules = async (courseId: string) => {
    if (!courseId) {
      setAccessRules([]);
      return;
    }
    setAccessRulesBusy(true);
    try {
      const result = await EduService.listAdminCourseAccessRules({
        courseId,
        studentScope: 'all_students',
        page: 1,
        pageSize: 100,
      });
      setAccessRules(result.items || []);
    } catch (error) {
      setAccessRulesMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to load access rules right now.',
      });
    } finally {
      setAccessRulesBusy(false);
    }
  };

  const syncLessonForm = (entry: AdminLessonEntry | null) => {
    setLessonForm({
      watchLimit: Math.max(Number(entry?.lesson.watchLimit || 2), 1),
      watchCompletionPercent: Math.min(Math.max(Number(entry?.lesson.watchCompletionPercent || 90), 50), 100),
    });
  };

  const handleSelect = (courseId: string) => {
    setSelectedCourseId(courseId);
    const nextCourse = courses.find((course) => course._id === courseId) || null;
    const nextLessonEntries = flattenLessonEntries(nextCourse);
    syncForm(nextCourse);
    const nextLessonId = nextLessonEntries[0]?.lesson.id || '';
    setSelectedLessonId(nextLessonId);
    const nextLessonEntry = nextLessonEntries.find((entry) => entry.lesson.id === nextLessonId) || null;
    syncLessonForm(nextLessonEntry);
    setEditing(false);
    setMessage({ type: null, text: '' });
    setLessonMessage({ type: null, text: '' });
    setAccessRulesMessage({ type: null, text: '' });
  };

  const handleLessonSelect = (lessonId: string) => {
    setSelectedLessonId(lessonId);
    const nextLesson = lessonEntries.find((entry) => entry.lesson.id === lessonId) || null;
    syncLessonForm(nextLesson);
    setLessonMessage({ type: null, text: '' });
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

  const handleLessonSave = async () => {
    if (!selectedCourse || !selectedLessonEntry) {
      return;
    }

    setLessonBusy(true);
    try {
      await EduService.updateLessonSettings(
        selectedCourse._id,
        selectedLessonEntry.moduleId,
        selectedLessonEntry.lesson.id,
        {
          chapterId: selectedLessonEntry.chapterId,
          watchLimit: Math.max(Number(lessonForm.watchLimit || 1), 1),
          watchCompletionPercent: Math.min(Math.max(Number(lessonForm.watchCompletionPercent || 90), 50), 100),
        },
      );
      setLessonMessage({ type: 'success', text: 'Lesson watch settings updated successfully.' });
      await refresh();
    } catch (error) {
      setLessonMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to update lesson watch settings right now.',
      });
    } finally {
      setLessonBusy(false);
    }
  };

  const handleRuleSave = async () => {
    if (!selectedCourse) {
      return;
    }

    setAccessRulesBusy(true);
    try {
      const lessonTarget = lessonEntries.find((entry) => entry.lesson.id === ruleForm.lessonId) || null;
      await EduService.upsertAdminCourseAccessRule({
        courseId: selectedCourse._id,
        studentScope: 'all_students',
        contentScope: ruleForm.contentScope,
        chapterId: ruleForm.contentScope === 'chapter'
          ? ruleForm.chapterId
          : ruleForm.contentScope === 'lesson'
            ? lessonTarget?.chapterId || undefined
            : undefined,
        lessonId: ruleForm.contentScope === 'lesson' ? ruleForm.lessonId : undefined,
        moduleId: ruleForm.contentScope === 'lesson' ? lessonTarget?.moduleId : undefined,
        access: ruleForm.access,
        adminNote: ruleForm.adminNote || undefined,
      });
      setAccessRulesMessage({ type: 'success', text: 'Course access rule saved successfully.' });
      setRuleForm((current) => ({ ...current, adminNote: '' }));
      await loadAccessRules(selectedCourse._id);
      await refresh();
    } catch (error) {
      setAccessRulesMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save the access rule right now.',
      });
    } finally {
      setAccessRulesBusy(false);
    }
  };

  const handleRuleDelete = async (ruleId: string) => {
    if (!selectedCourse) {
      return;
    }
    setAccessRulesBusy(true);
    try {
      await EduService.deleteAdminCourseAccessRule(ruleId);
      setAccessRulesMessage({ type: 'success', text: 'Course access rule deleted successfully.' });
      await loadAccessRules(selectedCourse._id);
      await refresh();
    } catch (error) {
      setAccessRulesMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to delete the access rule right now.',
      });
    } finally {
      setAccessRulesBusy(false);
    }
  };

  useEffect(() => {
    void loadAccessRules(selectedCourseId);
  }, [selectedCourseId]);

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
            <>
              <div className="rounded-[24px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink-soft)]">
                <p><span className="font-semibold text-[var(--ink)]">Exam:</span> {selectedCourse.exam}</p>
                <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Subjects:</span> {selectedCourse.modules.length}</p>
                <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Topics:</span> {selectedCourse.lessonCount || totalTopics}</p>
                <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Course fee:</span> {Number(selectedCourse.price || 0) === 0 ? 'Free' : currency.format(selectedCourse.price || 0)}</p>
                <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Offer:</span> {Number(selectedCourse.offerPercentage || 0)}%</p>
                <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Payable:</span> {Number(selectedCourse.price || 0) === 0 ? 'Free' : currency.format(getDiscountedPrice(selectedCourse.price || 0, selectedCourse.offerPercentage || 0))}</p>
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">Lesson watch controls</p>
                    <p className="mt-1 text-xs text-[var(--ink-soft)]">Increase or decrease the allowed watches for each lesson video.</p>
                  </div>
                </div>

                {lessonEntries.length > 0 ? (
                  <div className="mt-4 space-y-4">
                    <label className="space-y-2">
                      <span className="block text-sm font-semibold text-[var(--ink)]">Select lesson</span>
                      <select
                        value={selectedLessonId}
                        onChange={(event) => handleLessonSelect(event.target.value)}
                        className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
                      >
                        <option value="">-- Choose a lesson --</option>
                        {lessonEntries.map((entry) => (
                          <option key={`${entry.moduleId}:${entry.chapterId || 'root'}:${entry.lesson.id}`} value={entry.lesson.id}>
                            {[entry.moduleTitle, entry.chapterTitle, entry.lesson.title].filter(Boolean).join(' • ')}
                          </option>
                        ))}
                      </select>
                    </label>

                    {selectedLessonEntry && (
                      <>
                        <div className="rounded-2xl bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]">
                          <p><span className="font-semibold text-[var(--ink)]">Lesson:</span> {selectedLessonEntry.lesson.title}</p>
                          <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Path:</span> {[selectedLessonEntry.moduleTitle, selectedLessonEntry.chapterTitle].filter(Boolean).join(' • ') || 'Direct module lesson'}</p>
                          <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Duration:</span> {selectedLessonEntry.lesson.durationMinutes || 0} min</p>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <label className="space-y-2">
                            <span className="block text-sm font-semibold text-[var(--ink)]">Allowed full watches</span>
                            <input
                              type="number"
                              min="1"
                              max="20"
                              value={lessonForm.watchLimit}
                              onChange={(event) => setLessonForm((current) => ({ ...current, watchLimit: Number(event.target.value) }))}
                              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                            />
                            <span className="block text-xs text-[var(--ink-soft)]">Set how many completed watches a student gets for this lesson.</span>
                          </label>

                          <label className="space-y-2">
                            <span className="block text-sm font-semibold text-[var(--ink)]">Completion threshold (%)</span>
                            <input
                              type="number"
                              min="50"
                              max="100"
                              value={lessonForm.watchCompletionPercent}
                              onChange={(event) => setLessonForm((current) => ({ ...current, watchCompletionPercent: Number(event.target.value) }))}
                              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                            />
                            <span className="block text-xs text-[var(--ink-soft)]">A watch counts as completed after this percentage of the lesson is watched.</span>
                          </label>
                        </div>

                        <button
                          onClick={() => void handleLessonSave()}
                          disabled={lessonBusy}
                          className="flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        >
                          {lessonBusy ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                          Save lesson watch settings
                        </button>

                        {lessonMessage.type && (
                          <div className={`rounded-2xl px-4 py-3 text-sm ${lessonMessage.type === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-red-50 text-red-600'}`}>
                            {lessonMessage.text}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-[var(--line)] px-4 py-4 text-sm text-[var(--ink-soft)]">
                    This course does not have lessons yet. Add lessons first, then you can set watch limits here.
                  </div>
                )}
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">All-student content access</p>
                    <p className="mt-1 text-xs text-[var(--ink-soft)]">Allow or block the full course, one chapter, or one lesson for everyone enrolled in this course.</p>
                  </div>
                </div>

                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="block text-sm font-semibold text-[var(--ink)]">Scope</span>
                      <select
                        value={ruleForm.contentScope}
                        onChange={(event) => setRuleForm((current) => ({
                          ...current,
                          contentScope: event.target.value,
                          chapterId: '',
                          lessonId: '',
                        }))}
                        className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-[var(--ink)] outline-none"
                      >
                        <option value="course">Whole course</option>
                        <option value="chapter">One chapter</option>
                        <option value="lesson">One lesson</option>
                      </select>
                    </label>

                    <label className="space-y-2">
                      <span className="block text-sm font-semibold text-[var(--ink)]">Access</span>
                      <select
                        value={ruleForm.access}
                        onChange={(event) => setRuleForm((current) => ({ ...current, access: event.target.value }))}
                        className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-[var(--ink)] outline-none"
                      >
                        <option value="block">Block</option>
                        <option value="allow">Allow</option>
                      </select>
                    </label>
                  </div>

                  {ruleForm.contentScope === 'chapter' && (
                    <label className="space-y-2">
                      <span className="block text-sm font-semibold text-[var(--ink)]">Chapter</span>
                      <select
                        value={ruleForm.chapterId}
                        onChange={(event) => setRuleForm((current) => ({ ...current, chapterId: event.target.value }))}
                        className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-[var(--ink)] outline-none"
                      >
                        <option value="">-- Choose a chapter --</option>
                        {chapterEntries.map((entry) => (
                          <option key={`${entry.moduleId}:${entry.chapterId}`} value={entry.chapterId}>
                            {[entry.moduleTitle, entry.chapterTitle].filter(Boolean).join(' • ')}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {ruleForm.contentScope === 'lesson' && (
                    <label className="space-y-2">
                      <span className="block text-sm font-semibold text-[var(--ink)]">Lesson</span>
                      <select
                        value={ruleForm.lessonId}
                        onChange={(event) => setRuleForm((current) => ({ ...current, lessonId: event.target.value }))}
                        className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-[var(--ink)] outline-none"
                      >
                        <option value="">-- Choose a lesson --</option>
                        {lessonEntries.map((entry) => (
                          <option key={`${entry.moduleId}:${entry.chapterId || 'root'}:${entry.lesson.id}`} value={entry.lesson.id}>
                            {[entry.moduleTitle, entry.chapterTitle, entry.lesson.title].filter(Boolean).join(' • ')}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label className="space-y-2">
                    <span className="block text-sm font-semibold text-[var(--ink)]">Admin note</span>
                    <input
                      value={ruleForm.adminNote}
                      onChange={(event) => setRuleForm((current) => ({ ...current, adminNote: event.target.value }))}
                      placeholder="Optional reason shown to students when blocked"
                      className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                    />
                  </label>

                  <button
                    onClick={() => void handleRuleSave()}
                    disabled={accessRulesBusy || (ruleForm.contentScope === 'chapter' && !ruleForm.chapterId) || (ruleForm.contentScope === 'lesson' && !ruleForm.lessonId)}
                    className="flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {accessRulesBusy ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save all-student access rule
                  </button>

                  {accessRulesMessage.type && (
                    <div className={`rounded-2xl px-4 py-3 text-sm ${accessRulesMessage.type === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-red-50 text-red-600'}`}>
                      {accessRulesMessage.text}
                    </div>
                  )}

                  <div className="space-y-3">
                    <p className="text-sm font-semibold text-[var(--ink)]">Saved rules</p>
                    {accessRules.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-4 text-sm text-[var(--ink-soft)]">
                        No all-student content rules have been added for this course yet.
                      </div>
                    ) : (
                      accessRules.map((rule) => (
                        <div key={rule.ruleId} className="flex items-start justify-between gap-3 rounded-2xl bg-[var(--accent-cream)] px-4 py-3 text-sm">
                          <div>
                            <p className="font-semibold text-[var(--ink)]">
                              {[rule.contentScope, rule.chapterTitle, rule.lessonTitle].filter(Boolean).join(' • ')} • {rule.access}
                            </p>
                            <p className="mt-1 text-[var(--ink-soft)]">{rule.adminNote || 'No admin note added.'}</p>
                          </div>
                          <button
                            onClick={() => void handleRuleDelete(rule.ruleId)}
                            disabled={accessRulesBusy}
                            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-600 disabled:opacity-60"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
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
