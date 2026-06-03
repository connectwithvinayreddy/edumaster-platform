import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader, Trash2, Upload, Video } from 'lucide-react';
import { EduService } from '../EduService';
import { CourseCard } from '../types';

const MAX_VIDEO_UPLOAD_MB = Number(import.meta.env.VITE_MAX_VIDEO_UPLOAD_MB || 2048);
const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
const VALID_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];

type AdminEditorialVideoUploadProps = {
  courses: CourseCard[];
  onVideoUploaded?: () => void;
};

const formatDate = (value?: string | null) => {
  if (!value) return 'Not uploaded yet';
  return new Date(value).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const AdminEditorialVideoUpload: React.FC<AdminEditorialVideoUploadProps> = ({ courses, onVideoUploaded }) => {
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?._id || '');
  const [title, setTitle] = useState('');
  const [weekLabel, setWeekLabel] = useState('');
  const [editorialDate, setEditorialDate] = useState(new Date().toISOString().slice(0, 10));
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info' | null; message: string }>({ type: null, message: '' });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedCourse = useMemo(
    () => courses.find((course) => course._id === selectedCourseId) || null,
    [courses, selectedCourseId],
  );

  const editorials = useMemo(
    () => [...(selectedCourse?.editorials || [])]
      .sort((left, right) => String(right.editorialDate || right.uploadedAt || '').localeCompare(String(left.editorialDate || left.uploadedAt || ''))),
    [selectedCourse?.editorials],
  );

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    if (!selectedFile) return;
    const lowerName = selectedFile.name.toLowerCase();
    const hasValidExtension = VALID_VIDEO_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
    if (selectedFile.size > MAX_VIDEO_UPLOAD_BYTES) {
      setStatus({ type: 'error', message: `Video file too large. Maximum ${MAX_VIDEO_UPLOAD_MB}MB allowed.` });
      return;
    }
    if (!hasValidExtension) {
      setStatus({ type: 'error', message: 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV.' });
      return;
    }
    setFile(selectedFile);
    if (!title.trim()) {
      setTitle(`${selectedCourse?.title || 'Course'} Weekly Editorial`);
    }
    setStatus({ type: 'info', message: `Selected ${selectedFile.name}` });
  };

  const handleUpload = async () => {
    if (!selectedCourseId || !title.trim() || !file) {
      setStatus({ type: 'error', message: 'Choose a course, title, and editorial video file.' });
      return;
    }

    setUploading(true);
    try {
      await EduService.uploadCourseEditorialVideo(selectedCourseId, file, {
        title: title.trim(),
        description: description.trim(),
        weekLabel: weekLabel.trim(),
        editorialDate,
        durationMinutes,
      });
      setStatus({ type: 'success', message: 'Editorial video uploaded successfully.' });
      setFile(null);
      setTitle('');
      setWeekLabel('');
      setDescription('');
      setDurationMinutes(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await onVideoUploaded?.();
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : 'Editorial upload failed.' });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (editorialId: string) => {
    if (!selectedCourseId || !window.confirm('Delete this editorial video?')) return;
    setDeletingId(editorialId);
    try {
      await EduService.deleteCourseEditorialVideo(selectedCourseId, editorialId);
      setStatus({ type: 'success', message: 'Editorial video deleted successfully.' });
      await onVideoUploaded?.();
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : 'Delete failed.' });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6 rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
      <div>
        <h3 className="text-2xl font-semibold text-[var(--ink)]">Editorial Video Manager</h3>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">Upload one weekly protected editorial video under a course. Students can watch each editorial only one time.</p>
      </div>

      {status.type && (
        <div className={`flex items-start gap-3 rounded-[20px] border px-4 py-3 text-sm ${status.type === 'success' ? 'border-[var(--success)]/20 bg-[var(--success-soft)] text-[var(--success)]' : status.type === 'error' ? 'border-[var(--danger)]/20 bg-[var(--danger-soft)] text-[var(--danger)]' : 'border-[#d5e4ff] bg-[#f5f9ff] text-[#2f78eb]'}`}>
          {status.type === 'success' ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{status.message}</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <select value={selectedCourseId} onChange={(event) => setSelectedCourseId(event.target.value)} className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none">
          <option value="">-- Choose course --</option>
          {courses.map((course) => <option key={course._id} value={course._id}>{course.title}</option>)}
        </select>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Editorial title" className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none" />
        <input value={weekLabel} onChange={(event) => setWeekLabel(event.target.value)} placeholder="Week label, e.g. Week 23" className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none" />
        <input type="date" value={editorialDate} onChange={(event) => setEditorialDate(event.target.value)} className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none" />
        <input type="number" min={0} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} placeholder="Duration minutes" className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none" />
        <input ref={fileInputRef} type="file" accept=".mp4,.webm,.ogg,.mov,.mkv,video/*" onChange={handleFileSelect} className="block w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-[11px] text-sm text-[var(--ink)]" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Short description" className="md:col-span-2 min-h-[90px] rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none" />
      </div>

      <button type="button" onClick={() => void handleUpload()} disabled={uploading || !selectedCourseId || !title.trim() || !file} className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#1b5fe3] px-5 text-sm font-semibold text-white disabled:opacity-60">
        {uploading ? <Loader className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Upload Editorial
      </button>

      <div className="space-y-3">
        <h4 className="font-semibold text-[var(--ink)]">Course Editorials ({editorials.length})</h4>
        {editorials.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-soft)]">No editorial videos uploaded for this course yet.</div>
        ) : editorials.map((editorial) => (
          <div key={editorial.id} className="flex items-start justify-between gap-4 rounded-[22px] border border-[var(--line)] bg-white p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4 text-[var(--accent-rust)]" />
                <p className="truncate font-semibold text-[var(--ink)]">{editorial.title}</p>
              </div>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">{[editorial.weekLabel, editorial.editorialDate, `${editorial.durationMinutes || 0} min`, formatDate(editorial.uploadedAt)].filter(Boolean).join(' • ')}</p>
            </div>
            <button type="button" onClick={() => void handleDelete(editorial.id)} disabled={deletingId === editorial.id} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-600 disabled:opacity-60">
              {deletingId === editorial.id ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
