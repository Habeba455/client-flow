'use client';

import { useState } from 'react';
import { ClientOption, ProjectForm } from '@/components/project-form';

export function ProjectCreateButton({ clients }: { clients: ClientOption[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="ghost-link-button" onClick={() => setOpen(true)}>
        New project
      </button>
      {open ? (
        <ProjectForm
          mode="create"
          initial={{ name: '', description: null, status: 'active', projectType: null, targetCompletion: null, clientId: null }}
          clients={clients}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
