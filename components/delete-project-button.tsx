'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DeleteProjectButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const deleteProject = async () => {
    setPending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete project');
      }
      setOpen(false);
      router.push('/projects');
      router.refresh();
    } catch (error) {
      setPending(false);
      alert(error instanceof Error ? error.message : 'Failed to delete project');
    }
  };

  return (
    <>
      <button type="button" className="ghost-link-button danger-button" onClick={() => setOpen(true)}>
        Delete project
      </button>
      {open ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
          <div className="modal-card">
            <h3 id="delete-project-title">Delete project?</h3>
            <p>
              This will permanently remove <strong>{projectName}</strong> and its documents, tasks, and meeting notes. This cannot be undone.
            </p>
            <div className="inline-button-row">
              <button type="button" className="ghost-link-button" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <button type="button" className="primary-action danger-button" onClick={deleteProject} disabled={pending}>
                {pending ? 'Deleting...' : 'Delete project'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
