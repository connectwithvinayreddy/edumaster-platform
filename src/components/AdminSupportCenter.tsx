import React, { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, MessageSquare, Search, ShieldAlert } from 'lucide-react';
import { EduService } from '../EduService';
import {
  AdminLessonDoubtListResponse,
  AdminLessonReportListResponse,
  LessonDoubtThread,
  LessonReportRecord,
  SupportAttachment,
} from '../types';

type AdminSupportSection = 'lesson-doubts' | 'reports';

const emptyPagination = { page: 1, pageSize: 25, total: 0, totalPages: 1 };

const formatFileSize = (bytes?: number | null) => {
  const size = Number(bytes || 0);
  if (!size) {
    return '';
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentList: React.FC<{ attachments?: SupportAttachment[] }> = ({ attachments = [] }) => {
  if (!attachments.length) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-3 rounded-[12px] border border-[var(--line)] bg-white px-3 py-2 text-xs text-[var(--ink-soft)]"
        >
          <span className="min-w-0 truncate">{attachment.fileName}</span>
          <span className="shrink-0 uppercase">{attachment.kind}{formatFileSize(attachment.fileSize) ? ` • ${formatFileSize(attachment.fileSize)}` : ''}</span>
        </a>
      ))}
    </div>
  );
};

export const AdminSupportCenter: React.FC<{ section: AdminSupportSection }> = ({ section }) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doubts, setDoubts] = useState<LessonDoubtThread[]>([]);
  const [reports, setReports] = useState<LessonReportRecord[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [selectedDoubt, setSelectedDoubt] = useState<LessonDoubtThread | null>(null);
  const [selectedReport, setSelectedReport] = useState<LessonReportRecord | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [doubtFiles, setDoubtFiles] = useState<File[]>([]);
  const [reportFiles, setReportFiles] = useState<File[]>([]);

  const title = section === 'lesson-doubts' ? 'Lesson Doubts' : 'Video Reports';
  const loadedTestId = section === 'lesson-doubts' ? 'admin-lesson-doubts-loaded' : 'admin-reports-loaded';

  const refresh = async (page = pagination.page || 1) => {
    setLoading(true);
    setError(null);
    try {
      if (section === 'lesson-doubts') {
        const result = await EduService.listAdminLessonDoubts({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          status: statusFilter,
        }) as AdminLessonDoubtListResponse;
        setDoubts(result.items || []);
        setPagination(result.pagination || emptyPagination);
        setSelectedDoubt((current) => (current ? (result.items || []).find((item) => item._id === current._id) || result.items?.[0] || null : result.items?.[0] || null));
      } else {
        const result = await EduService.listAdminLessonReports({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          status: statusFilter,
        }) as AdminLessonReportListResponse;
        setReports(result.items || []);
        setPagination(result.pagination || emptyPagination);
        setSelectedReport((current) => (current ? (result.items || []).find((item) => item._id === current._id) || result.items?.[0] || null : result.items?.[0] || null));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load support data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  useEffect(() => {
    if (section === 'lesson-doubts') {
      setReplyDraft('');
      setNoteDraft('');
      return;
    }
    setReplyDraft(selectedReport?.adminReply || '');
    setNoteDraft(selectedReport?.adminNote || '');
  }, [section, selectedReport?._id, selectedReport?.adminReply, selectedReport?.adminNote]);

  const selectedStatus = useMemo(() => (
    section === 'lesson-doubts'
      ? selectedDoubt?.status || 'open'
      : selectedReport?.status || 'open'
  ), [section, selectedDoubt?.status, selectedReport?.status]);

  const submitReply = async () => {
    if (!selectedDoubt || !replyDraft.trim() || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const uploadedAttachments: SupportAttachment[] = [];
      for (const file of doubtFiles) {
        const upload = await EduService.uploadLessonSupportMedia(selectedDoubt.courseId, selectedDoubt.lessonId, file);
        uploadedAttachments.push(upload.attachment);
      }
      const response = await EduService.replyAdminLessonDoubt(selectedDoubt._id, {
        message: replyDraft.trim(),
        attachments: uploadedAttachments,
      });
      setReplyDraft('');
      setDoubtFiles([]);
      setSelectedDoubt(response.thread);
      setMessage(response.message || 'Reply sent successfully');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to send the reply.');
    } finally {
      setBusy(false);
    }
  };

  const updateDoubtStatus = async (status: string) => {
    if (!selectedDoubt || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await EduService.updateAdminLessonDoubtStatus(selectedDoubt._id, { status });
      setSelectedDoubt(response.thread);
      setMessage(response.message || 'Status updated');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to update the thread.');
    } finally {
      setBusy(false);
    }
  };

  const updateReport = async (status?: string) => {
    if (!selectedReport || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const uploadedAttachments: SupportAttachment[] = [];
      for (const file of reportFiles) {
        const upload = await EduService.uploadLessonSupportMedia(selectedReport.courseId, selectedReport.lessonId, file);
        uploadedAttachments.push(upload.attachment);
      }
      const response = await EduService.updateAdminLessonReport(selectedReport._id, {
        status,
        adminNote: noteDraft || undefined,
        adminReply: replyDraft || undefined,
        adminAttachments: uploadedAttachments.length ? uploadedAttachments : undefined,
      });
      setSelectedReport(response.report);
      setReportFiles([]);
      setMessage(response.message || 'Report updated');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to update the report.');
    } finally {
      setBusy(false);
    }
  };

  const items = section === 'lesson-doubts' ? doubts : reports;

  return (
    <div data-testid={loadedTestId} className="space-y-6">
      <section className="rounded-[28px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Admin support</p>
            <h3 className="mt-2 text-2xl font-semibold text-[var(--ink)]">{title}</h3>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex items-center gap-2 rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]">
              <Search className="h-4 w-4" />
              <input
                data-testid={section === 'lesson-doubts' ? 'admin-lesson-doubts-search' : 'admin-reports-search'}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search learner, course, lesson"
                className="min-w-[220px] bg-transparent text-[var(--ink)] outline-none"
              />
            </label>
            <select
              data-testid={section === 'lesson-doubts' ? 'admin-lesson-doubts-status-filter' : 'admin-reports-status-filter'}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--ink)]"
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="answered">Answered</option>
              <option value="resolved">Resolved</option>
              <option value="in_progress">In progress</option>
              <option value="rejected">Rejected</option>
            </select>
            <button
              type="button"
              onClick={() => void refresh(1)}
              className="rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        {message && <div className="mt-4 rounded-[18px] border border-[#cdecd8] bg-[#f4fff7] px-4 py-3 text-sm text-[#227a42]">{message}</div>}
        {error && <div className="mt-4 rounded-[18px] border border-[#ffd2d2] bg-[#fff6f6] px-4 py-3 text-sm text-[#b24141]">{error}</div>}

        <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[22px] border border-[var(--line)] bg-[var(--accent-cream)] p-4">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--ink-soft)]"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : items.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--ink-soft)]">No support items found.</div>
            ) : (
              <div data-testid={section === 'lesson-doubts' ? 'admin-lesson-doubts-table' : 'admin-reports-table'} className="space-y-3">
                {items.map((item) => {
                  const active = section === 'lesson-doubts'
                    ? selectedDoubt?._id === (item as LessonDoubtThread)._id
                    : selectedReport?._id === (item as LessonReportRecord)._id;
                  const issueOwnerName = 'studentName' in item ? item.studentName : item.userName;
                  const issueOwnerEmail = ('studentEmail' in item ? item.studentEmail : item.userEmail) || 'Email not available';
                  return (
                    <button
                      key={(item as LessonDoubtThread | LessonReportRecord)._id}
                      type="button"
                      data-testid={section === 'lesson-doubts' ? 'admin-lesson-doubt-row' : 'admin-lesson-report-row'}
                      onClick={() => {
                        setReplyDraft('');
                        setNoteDraft('');
                        if (section === 'lesson-doubts') {
                          setSelectedDoubt(item as LessonDoubtThread);
                        } else {
                          setSelectedReport(item as LessonReportRecord);
                        }
                      }}
                      className={`w-full rounded-[18px] border px-4 py-3 text-left ${active ? 'border-[#bfd3fb] bg-white shadow-[0_12px_24px_rgba(45,110,229,0.08)]' : 'border-transparent bg-white/70'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-[var(--ink)]">{issueOwnerName}</p>
                          <p className="mt-1 text-xs text-[var(--ink-soft)]">{issueOwnerEmail}</p>
                          <p className="mt-1 text-xs text-[var(--ink-soft)]">{item.pathLabel}</p>
                          <p className="mt-1 text-[11px] text-[var(--ink-soft)]">Updated: {'updatedAt' in item ? new Date((item.updatedAt || item.createdAt) as string).toLocaleString('en-IN') : 'NA'}</p>
                        </div>
                        <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2d6ee5]">{item.status}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex items-center justify-between text-xs text-[var(--ink-soft)]">
              <span data-testid={section === 'lesson-doubts' ? 'admin-lesson-doubts-pagination' : 'admin-reports-pagination'}>
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <div className="flex gap-2">
                <button type="button" onClick={() => void refresh(Math.max(1, pagination.page - 1))} disabled={pagination.page <= 1} className="rounded-[12px] border border-[var(--line)] bg-white px-3 py-2 disabled:opacity-50">Prev</button>
                <button type="button" onClick={() => void refresh(Math.min(pagination.totalPages, pagination.page + 1))} disabled={pagination.page >= pagination.totalPages} className="rounded-[12px] border border-[var(--line)] bg-white px-3 py-2 disabled:opacity-50">Next</button>
              </div>
            </div>
          </div>

          <div className="rounded-[22px] border border-[var(--line)] bg-white p-4">
            {section === 'lesson-doubts' ? (
              selectedDoubt ? (
                <div data-testid="admin-lesson-doubt-open-button" className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Thread</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--ink)]">{selectedDoubt.studentName}</p>
                    <p className="mt-1 text-sm text-[var(--ink-soft)]">{selectedDoubt.studentEmail || 'Email not available'}</p>
                    <p className="mt-1 text-sm text-[var(--ink-soft)]">{selectedDoubt.pathLabel}</p>
                  </div>
                  <div className="space-y-3 rounded-[18px] bg-[var(--accent-cream)] p-4">
                    {selectedDoubt.messages.map((entry) => (
                      <div key={entry._id} className="rounded-[14px] bg-white px-3 py-3">
                        <p className="text-xs font-semibold text-[var(--ink)]">{entry.userName}{entry.role === 'admin' ? ' • Admin' : ''}</p>
                        <p className="mt-2 text-sm text-[var(--ink-soft)]">{entry.message}</p>
                        <AttachmentList attachments={entry.attachments} />
                      </div>
                    ))}
                  </div>
                  <textarea
                    data-testid="admin-lesson-doubt-reply-input"
                    value={replyDraft}
                    onChange={(event) => setReplyDraft(event.target.value)}
                    placeholder="Reply to this learner…"
                    className="h-28 w-full rounded-[18px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                  />
                  <input
                    data-testid="admin-lesson-doubt-file-input"
                    type="file"
                    accept="image/*,video/*,audio/*"
                    multiple
                    onChange={(event) => setDoubtFiles(Array.from(event.target.files || []))}
                    className="w-full rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]"
                  />
                  {doubtFiles.length > 0 ? (
                    <div className="space-y-2 rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-xs text-[var(--ink-soft)]">
                      {doubtFiles.map((file) => (
                        <div key={`${file.name}-${file.size}`}>{file.name} {formatFileSize(file.size)}</div>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-3">
                    <button data-testid="admin-lesson-doubt-reply-send-button" type="button" onClick={() => void submitReply()} disabled={!replyDraft.trim() || busy} className="rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">Reply to learner</button>
                    <button type="button" onClick={() => void updateDoubtStatus('resolved')} disabled={busy} className="rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm">Close issue</button>
                    <select data-testid="admin-lesson-doubt-status-select" value={selectedStatus} onChange={(event) => void updateDoubtStatus(event.target.value)} className="rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm">
                      <option value="open">Open</option>
                      <option value="answered">Answered</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="rounded-[18px] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">Select a lesson doubt to review it.</div>
              )
            ) : selectedReport ? (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Report</p>
                  <p className="mt-2 text-lg font-semibold text-[var(--ink)]">{selectedReport.userName}</p>
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">{selectedReport.userEmail || 'Email not available'}</p>
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">{selectedReport.pathLabel}</p>
                  <p className="mt-1 text-xs text-[var(--ink-soft)]">Opened: {new Date(selectedReport.createdAt).toLocaleString('en-IN')} • Updated: {new Date(selectedReport.updatedAt).toLocaleString('en-IN')}</p>
                </div>
                <div data-testid="admin-report-detail" className="rounded-[18px] bg-[var(--accent-cream)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-soft)]">{selectedReport.issueType.replace(/_/g, ' ')}</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">{selectedReport.description}</p>
                  <AttachmentList attachments={selectedReport.attachments} />
                </div>
                {(selectedReport.adminReply || selectedReport.adminNote) && (
                  <div className="rounded-[18px] border border-[var(--line)] bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-soft)]">Existing admin update</p>
                    {selectedReport.adminReply ? <p className="mt-2 text-sm text-[var(--ink)]"><span className="font-semibold">Reply:</span> {selectedReport.adminReply}</p> : null}
                    {selectedReport.adminNote ? <p className="mt-2 text-sm text-[var(--ink-soft)]"><span className="font-semibold text-[var(--ink)]">Internal note:</span> {selectedReport.adminNote}</p> : null}
                    <AttachmentList attachments={selectedReport.adminAttachments} />
                  </div>
                )}
                <textarea
                  data-testid="admin-lesson-report-note-input"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="Internal note…"
                  className="h-24 w-full rounded-[18px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                />
                <textarea
                  data-testid="admin-lesson-report-reply-input"
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  placeholder="Reply for the learner…"
                  className="h-28 w-full rounded-[18px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 outline-none"
                />
                <input
                  data-testid="admin-lesson-report-file-input"
                  type="file"
                  accept="image/*,video/*,audio/*"
                  multiple
                  onChange={(event) => setReportFiles(Array.from(event.target.files || []))}
                  className="w-full rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]"
                />
                {reportFiles.length > 0 ? (
                  <div className="space-y-2 rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-xs text-[var(--ink-soft)]">
                    {reportFiles.map((file) => (
                      <div key={`${file.name}-${file.size}`}>{file.name} {formatFileSize(file.size)}</div>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  <button data-testid="admin-lesson-report-update-button" type="button" onClick={() => void updateReport()} disabled={busy || (!replyDraft.trim() && !noteDraft.trim())} className="rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">Send / save update</button>
                  <button type="button" onClick={() => void updateReport('in_progress')} disabled={busy} className="rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm">Mark in progress</button>
                  <button type="button" onClick={() => void updateReport('resolved')} disabled={busy} className="rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm">Close issue</button>
                </div>
              </div>
            ) : (
              <div className="rounded-[18px] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">Select a lesson report to review it.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
