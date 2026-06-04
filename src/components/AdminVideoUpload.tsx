import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Trash2, Play, Lock, Loader, AlertCircle, CheckCircle, RefreshCw } from 'lucide-react';
import { EduService } from '../EduService';

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

interface Video {
  id: string;
  title: string;
  videoUrl?: string;
  durationMinutes?: number;
  premium?: boolean;
  uploadedAt?: string;
  fileSize?: number;
  deliveryProfile?: string | null;
  hlsProcessingStatus?: string | null;
  hlsProcessingError?: string | null;
  playbackReady?: boolean;
  streamProvider?: string | null;
  storageProvider?: string | null;
  deliveryStrategy?: string | null;
  cloudflareStreamStatus?: string | null;
  cloudflareStreamPctComplete?: number | null;
  targetQualities?: string[];
  sourceFallbackAllowed?: boolean;
}

type ProcessingProvider = 'cloudflare-stream' | 'local-hls' | 'unknown';

interface Module {
  id: string;
  title: string;
  chapters?: Array<{
    id: string;
    title: string;
    lessons: Video[];
  }>;
  lessons: Video[];
}

interface CourseForUpload {
  _id: string;
  title: string;
  modules: Module[];
}

interface AdminVideoUploadProps {
  courses: CourseForUpload[];
  onVideoUploaded?: () => void;
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatDate = (dateString: string): string => {
  if (!dateString) return 'Recently added';
  return new Date(dateString).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const isFailedVideo = (video: Video): boolean => {
  const streamStatus = String(video.cloudflareStreamStatus || '').toLowerCase();
  const processingStatus = String(video.hlsProcessingStatus || '').toLowerCase();
  return streamStatus === 'failed' || processingStatus === 'failed';
};

const isProcessingVideo = (video: Video): boolean => {
  if (video.playbackReady) {
    return false;
  }

  const streamStatus = String(video.cloudflareStreamStatus || '').toLowerCase();
  const processingStatus = String(video.hlsProcessingStatus || '').toLowerCase();
  return ['queued', 'processing', 'upload-pending', 'pendingupload', 'inprogress'].includes(streamStatus)
    || ['queued', 'processing'].includes(processingStatus);
};

const getVideoProcessingProvider = (video: Video): ProcessingProvider => {
  const storageProvider = String(video.storageProvider || '').toLowerCase();
  const streamProvider = String(video.streamProvider || '').toLowerCase();
  const deliveryStrategy = String(video.deliveryStrategy || '').toLowerCase();
  const deliveryProfile = String(video.deliveryProfile || '').toLowerCase();

  if (
    storageProvider === 'cloudflare-stream'
    || streamProvider === 'cloudflare-stream'
    || deliveryStrategy === 'cloudflare-stream'
    || deliveryProfile === 'cloudflare-stream'
  ) {
    return 'cloudflare-stream';
  }

  if (
    deliveryStrategy === 'hls'
    || deliveryProfile.includes('hls')
    || storageProvider === 's3'
    || storageProvider === 'local'
  ) {
    return 'local-hls';
  }

  return 'unknown';
};

const getProviderLabel = (video: Video): string => {
  const provider = getVideoProcessingProvider(video);
  if (provider === 'cloudflare-stream') {
    return 'Legacy Cloudflare Stream';
  }
  if (provider === 'local-hls') {
    return 'Private adaptive HLS';
  }
  return 'Private video pipeline';
};

const getProcessingNotice = (video: Video): string => {
  const provider = getVideoProcessingProvider(video);
  if (provider === 'cloudflare-stream') {
    return 'This lesson still uses the legacy Cloudflare Stream path and should be migrated to the private adaptive HLS pipeline.';
  }
  if (provider === 'local-hls') {
    return 'Adaptive HLS packaging is running. Students will see the topic as soon as secure playback becomes available.';
  }
  return 'Students will not see this topic until video processing finishes.';
};

const getStudentVisibilityLabel = (video: Video): string => {
  if (video.playbackReady) {
    return 'Visible to students';
  }
  if (isFailedVideo(video)) {
    return 'Hidden from students';
  }
  if (isProcessingVideo(video)) {
    return 'Hidden until encoding finishes';
  }
  return 'Availability pending';
};

const getAdminPipelineState = (video: Video): 'Uploading' | 'Processing' | 'Ready' | 'Failed' => {
  const streamStatus = String(video.cloudflareStreamStatus || '').toLowerCase();
  const processingStatus = String(video.hlsProcessingStatus || '').toLowerCase();

  if (video.playbackReady) {
    return 'Ready';
  }
  if (isFailedVideo(video)) {
    return 'Failed';
  }
  if (['upload-pending', 'pendingupload'].includes(streamStatus)) {
    return 'Uploading';
  }
  if (['queued', 'processing'].includes(processingStatus) || ['queued', 'processing', 'inprogress'].includes(streamStatus)) {
    return 'Processing';
  }
  return 'Processing';
};

const getVideoSortRank = (video: Video): number => {
  if (video.playbackReady) {
    return 0;
  }
  if (isFailedVideo(video)) {
    return 2;
  }
  return 1;
};

export const AdminVideoUpload: React.FC<AdminVideoUploadProps> = ({ courses, onVideoUploaded }) => {
  const [selectedCourse, setSelectedCourse] = useState<string>(courses[0]?._id || '');
  const [selectedModule, setSelectedModule] = useState<string>('');
  const [selectedChapter, setSelectedChapter] = useState<string>('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [lessonTitle, setLessonTitle] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [isPremium, setIsPremium] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: 'success' | 'error' | 'info' | null;
    message: string;
  }>({ type: null, message: '' });
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploadLabel = uploadStatus.type === 'info' && uploadStatus.message
    ? uploadStatus.message
    : 'Uploading topic...';

  const currentCourse = courses.find((c) => c._id === selectedCourse);
  const currentModule = currentCourse?.modules?.find((m) => m.id === selectedModule);
  const currentChapter = currentModule?.chapters?.find((chapter) => chapter.id === selectedChapter);
  const sortedVideos = useMemo(() => [...videos].sort((left, right) => {
    const rankDifference = getVideoSortRank(left) - getVideoSortRank(right);
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return new Date(right.uploadedAt || 0).getTime() - new Date(left.uploadedAt || 0).getTime();
  }), [videos]);
  const failedVideoCount = sortedVideos.filter(isFailedVideo).length;
  const hasProcessingVideos = sortedVideos.some(isProcessingVideo);

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
        setUploadStatus({
          type: 'error',
          message: `Video file too large. Maximum ${MAX_VIDEO_UPLOAD_MB}MB allowed.`,
        });
        return;
      }

      const lowerName = file.name.toLowerCase();
      const hasValidExtension = VALID_VIDEO_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
      const hasValidMimeType = !file.type || VALID_VIDEO_MIME_TYPES.has(file.type);
      if (!hasValidExtension && !hasValidMimeType) {
        setUploadStatus({
          type: 'error',
          message: 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV',
        });
        return;
      }

      setVideoFile(file);
      setUploadStatus({ type: 'info', message: `Selected: ${file.name} (${formatFileSize(file.size)})` });

      // Try to extract duration (in minutes) from the selected file using an offscreen video element
      try {
        if (typeof window !== 'undefined' && window.URL && typeof document !== 'undefined') {
          const objectUrl = URL.createObjectURL(file);
          const tempVideo = document.createElement('video');
          tempVideo.preload = 'metadata';
          tempVideo.src = objectUrl;
          const handleLoaded = () => {
            try {
              const totalSeconds = Math.max(0, Math.floor(tempVideo.duration || 0));

              const minutes = Math.floor(totalSeconds / 60);
              const seconds = totalSeconds % 60;

              const duration = Number(`${minutes}.${String(seconds).padStart(2, "0")}`);
              setDurationMinutes(duration);
            } catch (err) {
              // ignore parsing errors
            } finally {
              URL.revokeObjectURL(objectUrl);
              tempVideo.removeEventListener('loadedmetadata', handleLoaded);
              tempVideo.remove();
            }
          };
          tempVideo.addEventListener('loadedmetadata', handleLoaded);
          // Ensure we revoke if an error occurs
          tempVideo.addEventListener('error', () => {
            try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
            tempVideo.remove();
          });
        }
      } catch (err) {
        // If anything goes wrong, leave durationMinutes as-is (default 0)
      }
    }
  };

  const handleUpload = async () => {
    if (!videoFile || !selectedCourse || !selectedModule || !lessonTitle) {
      setUploadStatus({
        type: 'error',
        message: 'Please select course, subject, choose a recording file, and enter a topic title',
      });
      return;
    }

    setUploading(true);
    setUploadStatus({
      type: 'info',
      message: videoFile.size > 90 * 1024 * 1024
        ? `Uploading topic directly to private storage... 0% (0 Bytes / ${formatFileSize(videoFile.size)})`
        : 'Uploading topic...',
    });
    try {
      const uploadResult = await EduService.uploadVideoToModule(
        selectedCourse,
        selectedModule,
        videoFile,
        lessonTitle,
        durationMinutes,
        isPremium,
        selectedChapter || undefined,
        {
          onProgress: ({ uploadedBytes, totalBytes, chunkIndex, totalChunks }) => {
            const percentage = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
            setUploadStatus({
              type: 'info',
              message: `Uploading topic... ${percentage}% (${formatFileSize(uploadedBytes)} / ${formatFileSize(totalBytes)}) • part ${chunkIndex + 1} of ${totalChunks}`,
            });
          },
        },
      );

      setUploadStatus({
        type: 'success',
        message: typeof (uploadResult as { message?: unknown })?.message === 'string'
          ? String((uploadResult as { message?: string }).message)
          : `Topic "${lessonTitle}" uploaded successfully.`,
      });

      // Reset form
      setVideoFile(null);
      setLessonTitle('');
      setDurationMinutes(0);
      setIsPremium(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Refresh video list
      await loadModuleVideos();

      // Call callback
      if (onVideoUploaded) {
        onVideoUploaded();
      }
    } catch (err) {
      setUploadStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Upload failed. Please try again.',
      });
    } finally {
      setUploading(false);
    }
  };

  const loadModuleVideos = useCallback(async () => {
    if (selectedModule && selectedCourse) {
      try {
        const response = await EduService.listVideosInModule(selectedCourse, selectedModule, selectedChapter || null);
        if (Array.isArray(response)) {
          setVideos(response);
        } else if (response && typeof response === 'object' && 'videos' in response) {
          const moduleResponse = response as any;
          setVideos(moduleResponse.videos || []);
        } else {
          setVideos([]);
        }
      } catch (err) {
        console.error('Failed to load topics:', err);
      }
    } else {
      setVideos([]);
    }
  }, [selectedChapter, selectedCourse, selectedModule]);

  useEffect(() => {
    void loadModuleVideos();
  }, [loadModuleVideos]);

  useEffect(() => {
    if (!hasProcessingVideos || uploading) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void loadModuleVideos();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasProcessingVideos, loadModuleVideos, uploading]);

  const handleDeleteVideo = async (videoId: string) => {
    if (!confirm('Are you sure you want to delete this topic?')) {
      return;
    }

    setDeleteLoading(videoId);
    try {
      await EduService.deleteVideoFromModule(selectedCourse, selectedModule, videoId);
      setUploadStatus({
        type: 'success',
        message: 'Topic deleted successfully',
      });
      await loadModuleVideos();
    } catch (err) {
      setUploadStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Delete failed',
      });
    } finally {
      setDeleteLoading(null);
    }
  };

  const handleDeleteFailedVideos = async () => {
    const failedVideos = sortedVideos.filter(isFailedVideo);
    if (failedVideos.length === 0) {
      return;
    }

    if (!confirm(`Delete ${failedVideos.length} failed upload${failedVideos.length === 1 ? '' : 's'} from this ${currentChapter ? 'chapter' : 'subject'}?`)) {
      return;
    }

    setBulkDeleteLoading(true);
    setUploadStatus({
      type: 'info',
      message: `Removing ${failedVideos.length} failed upload${failedVideos.length === 1 ? '' : 's'}...`,
    });

    try {
      for (const video of failedVideos) {
        await EduService.deleteVideoFromModule(selectedCourse, selectedModule, video.id);
      }
      setUploadStatus({
        type: 'success',
        message: `Removed ${failedVideos.length} failed upload${failedVideos.length === 1 ? '' : 's'}.`,
      });
      await loadModuleVideos();
    } catch (err) {
      setUploadStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed uploads could not be removed.',
      });
    } finally {
      setBulkDeleteLoading(false);
    }
  };

  const handleRetryVideo = async (videoId: string) => {
    setRetryLoading(videoId);
    setUploadStatus({
      type: 'info',
      message: 'Restarting video processing...',
    });

    try {
      const response = await EduService.retryVideoProcessing(
        selectedCourse,
        selectedModule,
        videoId,
        selectedChapter || null,
      ) as { message?: string };

      setUploadStatus({
        type: 'success',
        message: typeof response?.message === 'string'
          ? response.message
          : 'Video processing restarted successfully.',
      });
      await loadModuleVideos();
    } catch (err) {
      setUploadStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Video processing retry failed.',
      });
    } finally {
      setRetryLoading(null);
    }
  };

  return (
    <div className="space-y-6 rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
      <div>
        <h3 className="text-2xl font-semibold text-[var(--ink)]">Video Upload Manager</h3>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Upload topic videos into private hosting inside a course subject and optional chapter so students see the same learning structure.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Select Course</label>
          <select
            value={selectedCourse}
            onChange={(e) => {
              setSelectedCourse(e.target.value);
              setSelectedModule('');
              setSelectedChapter('');
              setVideos([]);
            }}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
          >
            <option value="">-- Choose a course --</option>
            {courses.map((course) => (
              <option key={course._id} value={course._id}>
                {course.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Select Subject</label>
          <select
            value={selectedModule}
            onChange={(e) => {
              setSelectedModule(e.target.value);
              setSelectedChapter('');
              setVideos([]);
            }}
            disabled={!selectedCourse}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none disabled:opacity-50 focus:border-[var(--accent-rust)]"
          >
            <option value="">-- Choose a subject --</option>
            {currentCourse?.modules?.map((module) => (
              <option key={module.id} value={module.id}>
                {module.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Select Chapter</label>
          <select
            value={selectedChapter}
            onChange={(e) => {
              setSelectedChapter(e.target.value);
              setVideos([]);
            }}
            disabled={!selectedModule}
            className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none disabled:opacity-50 focus:border-[var(--accent-rust)]"
          >
            <option value="">-- Save directly under subject --</option>
            {(currentModule?.chapters || []).map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapter.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-4 rounded-[24px] border-2 border-dashed border-[var(--line)] bg-[var(--accent-cream)] p-6">
        <h4 className="font-semibold text-[var(--ink)]">Upload Topic Video</h4>
        <p className="text-sm text-[var(--ink-soft)]">
          {currentChapter
            ? `This topic will be added inside chapter "${currentChapter.title}".`
            : 'If no chapter is selected, the topic is added directly under the subject.'}
        </p>

        <div>
          <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Session Recording File</label>
          <div
            className="relative rounded-2xl border-2 border-dashed border-[var(--line)] p-6 text-center cursor-pointer transition hover:border-[var(--accent-rust)]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) {
                const input = fileInputRef.current;
                if (input) {
                  const dataTransfer = new DataTransfer();
                  dataTransfer.items.add(file);
                  input.files = dataTransfer.files;
                  handleVideoSelect({ target: { files: dataTransfer.files } } as any);
                }
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleVideoSelect}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <div className="flex flex-col items-center gap-2 pointer-events-none">
              <Upload className="h-8 w-8 text-[var(--accent-rust)]" />
              <div>
                <p className="font-semibold text-[var(--ink)]">Drag & drop or click to select</p>
                <p className="text-sm text-[var(--ink-soft)]">MP4, WebM, OGG, MOV, MKV • Max {MAX_VIDEO_UPLOAD_MB}MB • Stored privately with signed playback access</p>
              </div>
            </div>
            {videoFile && (
              <div className="mt-3 text-sm text-[var(--ink)]">
                ✓ {videoFile.name} ({formatFileSize(videoFile.size)})
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Topic Title</label>
            <input
              type="text"
              value={lessonTitle}
              onChange={(e) => setLessonTitle(e.target.value)}
              placeholder="e.g., Topic 1 - Theodolite setup"
              className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-[var(--ink)] mb-2">Duration (minutes)</label>
            <input
              value={durationMinutes}
              min="0"
              className="w-full rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none focus:border-[var(--accent-rust)]"
            />
          </div>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isPremium}
            onChange={(e) => setIsPremium(e.target.checked)}
            className="rounded border border-[var(--line)]"
          />
          <span className="text-sm font-medium text-[var(--ink)]">Mark as premium (leave off to make this a demo preview students can watch before buying)</span>
        </label>

        {uploadStatus.type && (
          <div
            className={`flex items-start gap-3 rounded-[20px] p-4 ${uploadStatus.type === 'success'
              ? 'bg-[var(--success-soft)] text-[var(--success)]'
              : uploadStatus.type === 'error'
                ? 'bg-red-50 text-red-600'
                : 'bg-blue-50 text-blue-600'
              }`}
          >
            {uploadStatus.type === 'success' && <CheckCircle className="h-5 w-5 shrink-0 mt-0.5" />}
            {uploadStatus.type === 'error' && <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />}
            {uploadStatus.type === 'info' && <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />}
            <p className="text-sm">{uploadStatus.message}</p>
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={uploading || !videoFile || !selectedCourse || !selectedModule || !lessonTitle}
          className="w-full rounded-2xl bg-[var(--accent-rust)] px-6 py-3 font-semibold text-white transition hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {uploading ? (
            <>
              <Loader className="h-5 w-5 animate-spin" />
              <span className="truncate">{activeUploadLabel}</span>
            </>
          ) : (
            <>
              <Upload className="h-5 w-5" />
              Upload To Private Hosting
            </>
          )}
        </button>
      </div>

      {selectedModule && currentModule && (
        <div className="space-y-4">
          <div>
            <h4 className="font-semibold text-[var(--ink)]">
              Topics in "{currentChapter?.title || currentModule.title}" ({videos.length})
            </h4>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              {currentChapter ? `Chapter inside ${currentModule.title}` : 'Direct topics under the selected subject'}
            </p>
            {hasProcessingVideos && (
              <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                <Loader className="h-3.5 w-3.5 animate-spin" />
                Checking upload readiness every few seconds
              </p>
            )}
          </div>

          {failedVideoCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <p>
                {failedVideoCount} failed upload{failedVideoCount === 1 ? '' : 's'} found in this view. The ready topic stays untouched.
              </p>
              <button
                onClick={handleDeleteFailedVideos}
                disabled={bulkDeleteLoading}
                className="rounded-xl border border-red-200 bg-white px-4 py-2 font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
              >
                {bulkDeleteLoading ? 'Removing failed uploads...' : 'Remove failed uploads'}
              </button>
            </div>
          )}

          {videos.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-[var(--line)] p-6 text-center text-[var(--ink-soft)]">
              No topics uploaded yet. Add one above to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {sortedVideos.map((video) => (
                <div
                  key={video.id}
                  className={`flex items-start justify-between gap-4 rounded-[20px] border p-4 ${isFailedVideo(video)
                    ? 'border-red-200 bg-red-50/70'
                    : 'border-[var(--line)] bg-[var(--accent-cream)]'
                    }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-[var(--ink)]">{video.title}</p>
                      {video.premium && (
                        <div title="Premium - enrolled users only">
                          <Lock className="h-4 w-4 text-[var(--accent-rust)]" />
                        </div>
                      )}
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${video.playbackReady
                          ? 'bg-[var(--success-soft)] text-[var(--success)]'
                          : isFallbackPlayableVideo(video)
                            ? 'bg-blue-100 text-blue-700'
                            : isFailedVideo(video)
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                      >
                        {getStudentVisibilityLabel(video)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--ink-soft)]">
                      <span>Duration: {video.durationMinutes || 0} min</span>
                      {Boolean(video.fileSize) && (
                        <>
                          <span>•</span>
                          <span>Size: {formatFileSize(video.fileSize || 0)}</span>
                        </>
                      )}
                      <span>•</span>
                      <span>{formatDate(video.uploadedAt)}</span>
                      {video.deliveryProfile && (
                        <>
                          <span>•</span>
                          <span>Pipeline: {getProviderLabel(video)}</span>
                        </>
                      )}
                      {(video.hlsProcessingStatus || video.cloudflareStreamStatus || video.playbackReady) && (
                        <>
                          <span>•</span>
                          <span>State: {getAdminPipelineState(video)}</span>
                        </>
                      )}
                      {typeof video.cloudflareStreamPctComplete === 'number' && !video.playbackReady && (
                        <>
                          <span>•</span>
                          <span>{Math.round(video.cloudflareStreamPctComplete)}%</span>
                        </>
                      )}
                    </div>
                    {video.targetQualities?.length ? (
                      <p className="mt-2 text-xs text-[var(--ink-soft)]">
                        Cost-saver targets: {video.targetQualities.join(', ')}
                      </p>
                    ) : null}
                    {video.hlsProcessingError ? (
                      <p className="mt-2 text-xs text-red-600">
                        HLS processing issue: {video.hlsProcessingError}
                      </p>
                    ) : null}
                    {getVideoProcessingProvider(video) === 'cloudflare-stream' ? (
                      <p className="mt-2 text-xs font-medium text-amber-700">
                        Legacy Cloudflare Stream lesson detected. Migrate this lesson to the private adaptive HLS pipeline before using it as a staging baseline.
                      </p>
                    ) : null}
                    {isFailedVideo(video) ? (
                      <p className="mt-2 text-xs font-medium text-red-700">
                        This lesson is not playable yet. Retry processing first, or remove it if you already uploaded a working replacement.
                      </p>
                    ) : null}
                    {isProcessingVideo(video) ? (
                      <p className="mt-2 text-xs font-medium text-amber-700">
                        {getProcessingNotice(video)}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex gap-2">
                    {isFailedVideo(video) && (
                      <button
                        onClick={() => handleRetryVideo(video.id)}
                        disabled={retryLoading === video.id || deleteLoading === video.id || bulkDeleteLoading}
                        className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                        title="Retry processing"
                      >
                        {retryLoading === video.id ? (
                          <Loader className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => video.videoUrl && window.open(video.videoUrl, '_blank')}
                      disabled={!video.videoUrl}
                      className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[var(--ink)] transition hover:border-[var(--accent-rust)]"
                      title="Preview"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteVideo(video.id)}
                      disabled={deleteLoading === video.id || bulkDeleteLoading}
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-600 transition hover:bg-red-100 disabled:opacity-50"
                      title="Delete"
                    >
                      {deleteLoading === video.id ? (
                        <Loader className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-[24px] bg-blue-50 p-4 text-sm text-blue-900">
        <p className="font-semibold mb-2">ℹ️ How it works:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Select a course, then choose the subject and optional chapter where you want to add topics</li>
          <li>Upload your recorded session file here and the backend stores it in private hosting outside public lesson URLs</li>
          <li>New uploads start background HLS packaging immediately after upload, and students can watch only after the private adaptive stream is ready</li>
          <li>Students receive only short-lived signed playback links from the secure backend API</li>
          <li>Mark topics as premium so only enrolled students can request playback tokens and access the stream</li>
          <li>Leave premium turned off when you want a demo preview video visible before the course is purchased</li>
          <li>Topics appear in order and later topics can stay locked until the previous topic is completed</li>
          <li>Manage or delete topics anytime using the buttons above</li>
        </ul>
      </div>
    </div>
  );
};
