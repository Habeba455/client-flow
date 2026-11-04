import { db } from '@/lib/db';
import { ApiInputError } from '@/lib/api-validation';
import { ensureClientProjectLinksTable } from '@/lib/workspace/schema';

/** Throws 404 unless the project exists and belongs to the user. */
export async function assertProjectOwned(userId: string, projectId: string): Promise<void> {
  const row = await db.queryOne<{ id: string }>(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
  if (!row) throw new ApiInputError('Project not found', 404);
}

/**
 * Single entry point for linking a project to a client (or unlinking with null).
 * Writes both client_project_links (queryable relation) and projects.metadata.clientId
 * (read by existing pages) in one transaction so the two cannot drift apart.
 * A project has at most one client.
 */
export async function setProjectClient(userId: string, projectId: string, clientId: string | null): Promise<void> {
  await ensureClientProjectLinksTable();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const project = await client.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [projectId, userId]
    );
    if (!project.rows[0]) throw new ApiInputError('Project not found', 404);

    if (clientId) {
      const owned = await client.query(`SELECT 1 FROM clients WHERE id = $1 AND user_id = $2`, [clientId, userId]);
      if (!owned.rows[0]) throw new ApiInputError('Client not found', 404);
    }

    await client.query(`DELETE FROM client_project_links WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
    if (clientId) {
      await client.query(
        `INSERT INTO client_project_links (client_id, project_id, user_id, created_at) VALUES ($1, $2, $3, NOW())`,
        [clientId, projectId, userId]
      );
    }

    const metadata = { ...(project.rows[0].metadata || {}), clientId: clientId };
    await client.query(`UPDATE projects SET metadata = $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [
      projectId,
      userId,
      JSON.stringify(metadata),
    ]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
