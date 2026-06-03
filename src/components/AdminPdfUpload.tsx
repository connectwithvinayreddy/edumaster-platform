import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Loader, Lock, Trash2, Upload } from 'lucide-react';
import { EduService } from '../EduService';
import { CoursePdfAttachment } from '../types';

interface LessonOption {
  id: string;
  title: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
}

interface Module {
  id: string;
  title: string;
  lessons?: Array<{ id: string; title: string }>;
  chapters?: Array<{
    id: string;
    title: string;
    lessons?: Array<{ id: string; title: string }>;
  }>;
}

interface CourseForUpload {
  _id: string;
  title: string;
  modules: Module[];
}

interface AdminPdfUploadProps {
  courses: CourseForUpload[];
  onPdfUploaded?: () => void;
}

const formatDate = (value?: string | null) => {
  if (!value) {
    return 'Recently added';
  }
  return new Date(value).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatFileSize = (bytes?: number | null) => {
  const size = Number(bytes || 0);
  if (!size) {
    return '0 KB';
  }
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${Math.round((size / (1024 ** index)) * 100) / 100} ${units[index]}`;
};

export const AdminPdfUpload: React.FC<AdminPdfUploadProps> = ({ courses, onPdfUploaded }) => {
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?._id || '');
  const [selectedModuleId, setSelectedModuleId] = useState('');
  const [selectedChapterId, setSelectedChapterId] = useState('');
  const [selectedLessonId, setSelectedLessonId] = useState('');
  const scope: 'lesson' = 'lesson';
  const [title, setTitle] = useState('');
  const [premium, setPremium] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [attachments, setAttachments] = useState<CoursePdfAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedCourse = useMemo(
    () => courses.find((course) => course._id === selectedCourseId) || null,
    [courses, selectedCourseId],
  );
  const selectedModule = useMemo(
    () => selectedCourse?.modules.find((module) => module.id === selectedModuleId) || null,
    [selectedCourse, selectedModuleId],
  );
  const selectedChapter = useMemo(
    () => selectedModule?.chapters?.find((chapter) => chapter.id === selectedChapterId) || null,
    [selectedChapterId, selectedModule],
  );

  const lessonOptions = useMemo<LessonOption[]>(() => {
    if (!selectedModule) {
      return [];
    }

    if (selectedChapter) {
      return (selectedChapter.lessons || []).map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        chapterId: selectedChapter.id,
        chapterTitle: selectedChapter.title,
      }));
    }

    return [
      ...(selectedModule.lessons || []).map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        chapterId: null,
        chapterTitle: null,
      })),
      ...((selectedModule.chapters || []).flatMap((chapter) =>
        (chapter.lessons || []).map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
        })))),
    ];
  }, [selectedChapter, selectedModule]);

  const activeLessonOption = lessonOptions.find((lesson) => lesson.id === selectedLessonId) || null;

  const loadAttachments = async () => {
    if (!selectedCourseId || !selectedModuleId) {
      setAttachments([]);
      return;
    }

    if (!selectedLessonId) {
      setAttachments([]);
      return;
    }

    try {
      const response = await EduService.listCoursePdfAttachments(selectedCourseId, selectedModuleId, {
        scope,
        chapterId: activeLessonOption?.chapterId || selectedChapterId || null,
        lessonId: selectedLessonId,
      });
      setAttachments(response.attachments || []);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Unable to load PDFs right now.' });
      setAttachments([]);
    }
  };

  useEffect(() => {
    void loadAttachments();
  }, [selectedCourseId, selectedModuleId, selectedChapterId, selectedLessonId, scope]);

  const resetUploadForm = () => {
    setTitle('');
    setPremium(true);
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleUpload = async () => {
    if (!selectedCourseId || !selectedModuleId || !title.trim() || !file) {
      setMessage({ type: 'error', text: 'Choose the course path, enter a PDF title, and select a PDF file.' });
      return;
    }
    if (!selectedLessonId) {
      setMessage({ type: 'error', text: 'Choose a lesson before uploading a lesson PDF.' });
      return;
    }

    setBusy(true);
    try {
      await EduService.uploadCoursePdfAttachment(selectedCourseId, selectedModuleId, file, {
        title: title.trim(),
        scope,
        chapterId: activeLessonOption?.chapterId || selectedChapterId || null,
        lessonId: selectedLessonId,
        premium,
      });
      setMessage({ type: 'success', text: 'Protected PDF uploaded successfully.' });
      resetUploadForm();
      await loadAttachments();
      onPdfUploaded?.();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'PDF upload failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (attachmentId: string) => {
    if (!window.confirm('Delete this protected PDF?')) {
      return;
    }

    setDeleteId(attachmentId);
    try {
      await EduService.deleteCoursePdfAttachment(selectedCourseId, selectedModuleId, attachmentId, {
        scope,
        chapterId: activeLessonOption?.chapterId || selectedChapterId || null,
        lessonId: selectedLessonId,
      });
      setMessage({ type: 'success', text: 'Protected PDF deleted successfully.' });
      await loadAttachments();
      onPdfUploaded?.();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Unable to delete this PDF right now.' });
    } finally {
      setDeleteId(null);
    }
  };

  return (
    <section className="space-y-6 rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
      <div>
        <h3 className="text-2xl font-semibold text-[var(--ink)]">Protected PDF Manager</h3>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Upload PDFs into the exact lesson path. Students can view them inside the app without getting a public download URL.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <select
          value={selectedCourseId}
          onChange={(event) => {
            setSelectedCourseId(event.target.value);
            setSelectedModuleId('');
            setSelectedChapterId('');
            setSelectedLessonId('');
          }}
          className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
        >
          <option value="">-- Choose course --</option>
          {courses.map((course) => (
            <option key={course._id} value={course._id}>{course.title}</option>
          ))}
        </select>

        <select
          value={selectedModuleId}
          onChange={(event) => {
            setSelectedModuleId(event.target.value);
            setSelectedChapterId('');
            setSelectedLessonId('');
          }}
          disabled={!selectedCourseId}
          className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)] disabled:opacity-60"
        >
          <option value="">-- Choose subject --</option>
          {(selectedCourse?.modules || []).map((module) => (
            <option key={module.id} value={module.id}>{module.title}</option>
          ))}
        </select>

        <div className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)]">
          Lesson PDF
        </div>

        <select
          value={selectedChapterId}
          onChange={(event) => {
            setSelectedChapterId(event.target.value);
            setSelectedLessonId('');
          }}
          disabled={!selectedModuleId}
          className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)] disabled:opacity-60"
        >
          <option value="">-- Any chapter / direct lesson --</option>
          {(selectedModule?.chapters || []).map((chapter) => (
            <option key={chapter.id} value={chapter.id}>{chapter.title}</option>
          ))}
        </select>
      </div>

      <select
        value={selectedLessonId}
        onChange={(event) => setSelectedLessonId(event.target.value)}
        disabled={!selectedModuleId}
        className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)] disabled:opacity-60"
      >
        <option value="">-- Choose lesson --</option>
        {lessonOptions.map((lesson) => (
          <option key={`${lesson.chapterId || 'module'}:${lesson.id}`} value={lesson.id}>
            {lesson.chapterTitle ? `${lesson.chapterTitle} • ` : ''}{lesson.title}
          </option>
        ))}
      </select>

      <div className="grid gap-4 rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] p-5 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="PDF title, e.g. Chapter formula sheet"
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          />
          <label className="flex items-center gap-3 rounded-2xl border border-dashed border-[var(--line)] bg-white px-4 py-4 text-sm text-[var(--ink)]">
            <Upload className="h-5 w-5 text-[var(--accent-rust)]" />
            <span className="min-w-0 flex-1 truncate">{file ? file.name : 'Choose PDF file'}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border border-[var(--line)] bg-[var(--accent-cream)] px-3 py-2 text-xs font-semibold text-[var(--ink)]"
            >
              Browse
            </button>
          </label>
          <label className="flex items-center gap-3 text-sm text-[var(--ink)]">
            <input type="checkbox" checked={premium} onChange={(event) => setPremium(event.target.checked)} />
            <span>Require paid course access for this PDF</span>
          </label>
        </div>

        <div className="flex flex-col justify-between gap-4 rounded-[20px] bg-white p-4">
          <div className="space-y-2 text-sm text-[var(--ink-soft)]">
            <p className="font-semibold text-[var(--ink)]">Upload destination</p>
            <p>{selectedCourse?.title || 'Choose a course'}{selectedModule ? ` > ${selectedModule.title}` : ''}{selectedChapter ? ` > ${selectedChapter.title}` : ''}{activeLessonOption ? ` > ${activeLessonOption.title}` : ''}</p>
            <p>Students see this inside the selected lesson PDF list.</p>
          </div>
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={busy || !selectedCourseId || !selectedModuleId || !title.trim() || !file}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[var(--accent-rust)] px-5 py-3 font-semibold text-white disabled:opacity-60"
          >
            {busy ? <Loader className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
            Upload protected PDF
          </button>
        </div>
      </div>

      {message.type && (
        <div className={`rounded-[18px] px-4 py-3 text-sm ${message.type === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-red-50 text-red-600'}`}>
          {message.text}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h4 className="font-semibold text-[var(--ink)]">Protected PDFs ({attachments.length})</h4>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">This list reflects the currently selected lesson.</p>
        </div>

        {attachments.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-soft)]">
            No PDFs uploaded for this lesson yet.
          </div>
        ) : (
          attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-start justify-between gap-4 rounded-[22px] border border-[var(--line)] bg-white p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-[var(--accent-rust)]" />
                  <p className="truncate font-semibold text-[var(--ink)]">{attachment.title}</p>
                  {attachment.premium ? <Lock className="h-4 w-4 text-[var(--accent-rust)]" /> : null}
                </div>
                <p className="mt-2 text-sm text-[var(--ink-soft)]">
                  {attachment.fileName || 'PDF'} • {formatFileSize(attachment.fileSize)} • {formatDate(attachment.uploadedAt)}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void handleDelete(attachment.id)}
                disabled={deleteId === attachment.id}
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-600 disabled:opacity-60"
              >
                {deleteId === attachment.id ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
