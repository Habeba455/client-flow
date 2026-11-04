'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, Panel, StatusPill } from '@/components/workspace-ui';

interface ProjectDocumentItem {
  id: string;
  fileName: string;
  summary: string | null;
  storageProvider: string | null;
  createdAt: string;
}

interface PendingDeleteDocument {
  id: string;
  fileName: string;
}

function formatStorageProvider(value: string | null): string {
  if (value === 'google_drive') return 'google drive';
  if (value === 'onedrive') return 'onedrive';
  if (value === 'local' || !value) return 'workspace';
  return value.replace(/_/g, ' ');
}

function documentSummaryPreview(summary: string | null): string {
  const normalized = summary?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'No summary available yet.';
  }
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function ProjectDocumentsWorkspace({
  projectId,
  initialDocuments,
}: {
  projectId: string;
  initialDocuments: ProjectDocumentItem[];
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [documents, setDocuments] = useState(initialDocuments);
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedDocumentId, setExpandedDocumentId] = useState<string | null>(initialDocuments[0]?.id || null);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteDocument | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDocuments(initialDocuments);
    setExpandedDocumentId((current) => {
      if (current && initialDocuments.some((document) => document.id === current)) {
        return current;
      }
      return initialDocuments[0]?.id || null;
    });
  }, [initialDocuments]);

  useEffect(() => {
    if (!pendingDelete) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deletingId) {
        setPendingDelete(null);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingDelete, deletingId]);

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    setUploading(true);
    setMessage(null);
    try {
      const body = new FormData();
      Array.from(files).forEach((file) => body.append('files', file));

      const response = await fetch(`/api/projects/${projectId}/documents`, {
        method: 'POST',
        body,
      });
      const data = (await response.json()) as {
        error?: string;
        documents?: Array<{
          id: string;
          file_name: string;
          summary: string | null;
          storage_provider: string | null;
          created_at: string;
        }>;
      };

      if (!response.ok) {
        throw new Error(data.error || 'Upload failed');
      }

      if (Array.isArray(data.documents)) {
        const nextDocuments = data.documents;
        setDocuments((current) => [
          ...nextDocuments.map((document) => ({
            id: document.id,
            fileName: document.file_name,
            summary: document.summary,
            storageProvider: document.storage_provider,
            createdAt: document.created_at,
          })),
          ...current,
        ]);
        if (nextDocuments[0]?.id) {
          setExpandedDocumentId(nextDocuments[0].id);
        }
      }

      setMessage(`${files.length} document${files.length === 1 ? '' : 's'} uploaded.`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const syncFromEmail = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
      const data = (await response.json()) as {
        error?: string;
        syncedEmails?: number;
        syncedMeetings?: number;
        ingestedAttachments?: number;
        generatedTodos?: number;
      };
      if (!response.ok) {
        throw new Error(data.error || 'Sync failed');
      }
      setMessage(
        `Project sync complete. ${data.syncedEmails || 0} email threads, ${data.syncedMeetings || 0} meetings, ${data.ingestedAttachments || 0} attachments, and ${
          data.generatedTodos || 0
        } AI-generated tasks refreshed.`
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const deleteDocument = async (documentId: string, fileName: string) => {
    setDeletingId(documentId);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/documents/${documentId}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Delete failed');
      }

      setDocuments((current) => current.filter((document) => document.id !== documentId));
      setExpandedDocumentId((current) => (current === documentId ? null : current));
      setPendingDelete(null);
      setMessage(`${fileName} deleted.`);
      router.refresh();
    } catch (error) {
      setPendingDelete(null);
      setMessage(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="page-stack">
      <Panel>
        <div className="document-upload-dropzone">
          <div className="upload-icon" />
          <h2>Upload documents</h2>
          <p>PDF, Word, Excel, TXT. Uploaded files are saved into project memory inside the workspace.</p>
          <button type="button" className="ghost-link-button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Choose Files'}
          </button>
          <input ref={fileInputRef} type="file" hidden multiple onChange={(event) => uploadFiles(event.target.files)} />
        </div>
        <div className="integration-chip-row">
          <button type="button" className="integration-chip integration-chip-button" onClick={syncFromEmail} disabled={syncing}>
            {syncing ? 'Syncing...' : 'From Email'}
          </button>
          <span className="integration-chip">Workspace storage only</span>
        </div>
        {message ? <p className="composer-hint">{message}</p> : null}
      </Panel>

      <Panel title="Project Documents" action={documents.length > 0 ? <StatusPill tone="neutral">{documents.length} files</StatusPill> : null}>
        {documents.length > 0 ? (
          <div className="document-list">
            {documents.map((document) => (
              <div key={document.id} className="document-row document-row-detailed">
                <div className="document-row-main">
                  <div>
                    <strong>{document.fileName}</strong>
                    <p>{documentSummaryPreview(document.summary)}</p>
                  </div>
                  <div className="inline-button-row">
                    <button
                      type="button"
                      className="ghost-link-button"
                      onClick={() => setExpandedDocumentId((current) => (current === document.id ? null : document.id))}
                    >
                      {expandedDocumentId === document.id ? 'Hide Summary' : 'Show Summary'}
                    </button>
                    <button
                      type="button"
                      className="ghost-link-button danger-button"
                      onClick={() => setPendingDelete({ id: document.id, fileName: document.fileName })}
                      disabled={deletingId === document.id}
                    >
                      {deletingId === document.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
                <div className="document-row-meta">
                  <span>{formatStorageProvider(document.storageProvider)}</span>
                  <small>{new Date(document.createdAt).toLocaleDateString()}</small>
                </div>
                {expandedDocumentId === document.id ? (
                  <div className="document-summary-panel">
                    <strong>AI Summary</strong>
                    <p>{document.summary || 'No summary is stored for this document yet.'}</p>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No documents yet" description="Upload files above or sync project emails to ingest attachments and summaries." />
        )}
      </Panel>

      {pendingDelete ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-document-title">
            <h3 id="delete-document-title">Delete document?</h3>
            <p className="modal-copy">
              Remove <strong>{pendingDelete.fileName}</strong> from this project. Its stored summary and extracted text will also be removed.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-link-button"
                onClick={() => setPendingDelete(null)}
                disabled={Boolean(deletingId)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action primary-action-danger"
                onClick={() => deleteDocument(pendingDelete.id, pendingDelete.fileName)}
                disabled={deletingId === pendingDelete.id}
              >
                {deletingId === pendingDelete.id ? 'Deleting...' : 'Delete Document'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
