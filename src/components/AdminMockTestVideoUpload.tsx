import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader, Play, Trash2, Upload } from 'lucide-react';
import { EduService } from '../EduService';
import { MockTest } from '../types';

const MAX_VIDEO_UPLOAD_MB = Number(import.meta.env.VITE_MAX_VIDEO_UPLOAD_MB || 2048);
const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
const VALID_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'application/x-matroska',
]);
const VALID_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];

type AdminMockTestVideoUploadProps = {
  tests: MockTest[];
  onVideoUploaded?: () => void;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatDate = (value?: string | null) => {
  if (!value) {
    return 'Not uploaded yet';
  }

  return new Date(value).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const AdminMockTestVideoUpload: React.FC<AdminMockTestVideoUploadProps> = ({ tests, onVideoUploaded }) => {
  const [selectedTestId, setSelectedTestId] = useState<string>(tests[0]?._id || '');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info' | null; message: string }>({
    type: null,
    message: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedTest = useMemo(
    () => tests.find((entry) => entry._id === selectedTestId) || null,
    [selectedTestId, tests],
  );

  const handleVideoSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
      setStatus({
        type: 'error',
        message: `Video file too large. Maximum ${MAX_VIDEO_UPLOAD_MB}MB allowed.`,
      });
      return;
    }

    const lowerName = file.name.toLowerCase();
    const hasValidExtension = VALID_VIDEO_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
    const hasValidMimeType = !file.type || VALID_VIDEO_MIME_TYPES.has(file.type);
    if (!hasValidExtension && !hasValidMimeType) {
      setStatus({
        type: 'error',
        message: 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV',
      });
      return;
    }

    setVideoFile(file);
    if (!videoTitle) {
      setVideoTitle(`${selectedTest?.title || 'Mock test'} explanation video`);
    }
    setStatus({
      type: 'info',
      message: `Selected: ${file.name} (${formatFileSize(file.size)})`,
    });
  };

  const handleUpload = async () => {
    if (!selectedTestId || !videoFile || !videoTitle.trim()) {
      setStatus({
        type: 'error',
        message: 'Choose a mock test, select a video file, and add a video title.',
      });
      return;
    }

    setUploading(true);
    try {
      await EduService.uploadMockTestVideo(selectedTestId, videoFile, videoTitle.trim(), durationMinutes);
      setStatus({
        type: 'success',
        message: 'Test-series video uploaded successfully.',
      });
      setVideoFile(null);
      setDurationMinutes(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await onVideoUploaded?.();
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Upload failed.',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedTestId || !selectedTest?.companionVideo) {
      return;
    }

    if (!confirm('Delete the current test-series video?')) {
      return;
    }

    setDeleting(true);
    try {
      await EduService.deleteMockTestVideo(selectedTestId);
      setStatus({
        type: 'success',
        message: 'Test-series video deleted successfully.',
      });
      setVideoFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await onVideoUploaded?.();
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Delete failed.',
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
      <div>
        <h3 className="text-2xl font-semibold text-[var(--ink)]">Mock Test Video Manager</h3>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Attach a secure explanation video directly to a test series so students can watch it from the mock-test workspace.
        </p>
      </div>

      {status.type && (
        <div
          className={[
            'flex items-start gap-3 rounded-[20px] border px-4 py-3 text-sm',
            status.type === 'success'
              ? 'border-[var(--success)]/20 bg-[var(--success-soft)] text-[var(--success)]'
              : status.type === 'error'
                ? 'border-[var(--danger)]/20 bg-[var(--danger-soft)] text-[var(--danger)]'
                : 'border-[#d5e4ff] bg-[#f5f9ff] text-[#2f78eb]',
          ].join(' ')}
        >
          {status.type === 'success' ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{status.message}</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-semibold text-[var(--ink)]">Select Mock Test</label>
          <select
            value={selectedTestId}
            onChange={(event) => setSelectedTestId(event.target.value)}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          >
            <option value="">-- Choose a mock test --</option>
            {tests.map((test) => (
              <option key={test._id} value={test._id}>
                {test.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm font-semibold text-[var(--ink)]">Video Title</label>
          <input
            value={videoTitle}
            onChange={(event) => setVideoTitle(event.target.value)}
            placeholder="Explanation video title"
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-semibold text-[var(--ink)]">Duration Minutes</label>
          <input
            type="number"
            min={0}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-semibold text-[var(--ink)]">Video File</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp4,.webm,.ogg,.mov,.mkv,video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska,application/x-matroska"
            onChange={handleVideoSelect}
            className="block w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-[11px] text-sm text-[var(--ink)]"
          />
        </div>
      </div>

      <div className="rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--ink)]">Current attached video</p>
            {selectedTest?.companionVideo ? (
              <>
                <p className="mt-2 text-base font-semibold text-[var(--ink)]">{selectedTest.companionVideo.title}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-[var(--ink-soft)]">
                  <span>{selectedTest.companionVideo.durationMinutes || 0} min</span>
                  <span>{selectedTest.companionVideo.hlsProcessingStatus || 'ready'}</span>
                  <span>{formatDate(selectedTest.companionVideo.uploadedAt)}</span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--ink-soft)]">No video is attached to this test yet.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#1b5fe3] px-5 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(37,99,235,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {uploading ? <Loader className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload Video
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || !selectedTest?.companionVideo}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-[var(--line)] bg-white px-5 text-sm font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete Video
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-[24px] border border-[var(--line)] bg-white p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#eef4ff] text-[#2f78eb]">
            <Play className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--ink)]">Student experience</p>
            <p className="text-sm text-[var(--ink-soft)]">
              Once uploaded, this video appears inside the test-series detail cards as a direct secure watch action.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
