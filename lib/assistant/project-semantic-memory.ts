import { createHash, randomUUID } from 'node:crypto';
import { generateText } from '@/lib/ai/provider';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { db } from '@/lib/db';

type ProjectMemorySourceType = 'project_record' | 'email' | 'meeting' | 'task' | 'document';

interface ProjectIdentityRow {
  id: string;
  user_id: string;
  name: string | null;
  title: string | null;
  description: string | null;
  summary: string | null;
  status: string | null;
  created_at: string;
  linked_contacts: unknown;
  metadata: Record<string, unknown> | null;
}

interface ProjectMetadata {
  clientEntity?: string | null;
  projectType?: string | null;
  startDate?: string | null;
  targetCompletion?: string | null;
  engagementValue?: string | null;
  projectOwner?: string | null;
  clients?: unknown;
  milestones?: unknown;
}

interface ProjectMemorySource {
  sourceType: ProjectMemorySourceType;
  sourceId: string;
  sourceTitle: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface DesiredChunk {
  id: string;
  projectId: string;
  userId: string;
  sourceType: ProjectMemorySourceType;
  sourceId: string;
  sourceTitle: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

interface ProjectMemoryChunkRow {
  id: string;
  project_id: string;
  user_id: string;
  source_type: ProjectMemorySourceType;
  source_id: string;
  source_title: string;
  chunk_index: number;
  content: string;
  embedding: unknown;
  content_hash: string;
  metadata: Record<string, unknown> | null;
}

export interface ProjectMemoryHit {
  id: string;
  sourceType: ProjectMemorySourceType;
  sourceId: string;
  sourceTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
  similarity: number;
  lexicalScore: number;
  metadata: Record<string, unknown>;
}

export interface ProjectMemoryEvidence {
  label: string;
  sourceType: ProjectMemorySourceType;
  sourceId: string;
  sourceTitle: string;
  score: number;
  metadata: Record<string, unknown>;
  excerpts: string[];
}

const PROJECT_REFRESH_TTL_MS = 15_000;
const MAX_EMBED_BATCH = 48;
const DOC_CHUNK_SIZE = 1_500;
const DOC_CHUNK_OVERLAP = 220;
const refreshTimestamps = new Map<string, number>();
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'along',
  'also',
  'been',
  'before',
  'being',
  'both',
  'could',
  'does',
  'done',
  'each',
  'from',
  'have',
  'into',
  'just',
  'more',
  'most',
  'much',
  'need',
  'only',
  'other',
  'over',
  'same',
  'some',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'very',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'your',
]);

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function readMetadataString(metadata: ProjectMetadata, key: keyof ProjectMetadata): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectClientLines(project: ProjectIdentityRow, members: Array<{ email: string | null; name: string | null }>): string[] {
  const lines = new Set<string>();
  const linkedContacts = normalizeStringArray(project.linked_contacts);
  linkedContacts.forEach((value) => lines.add(value));

  const metadata = (project.metadata || {}) as ProjectMetadata;
  const clientEntity = readMetadataString(metadata, 'clientEntity');
  if (clientEntity) {
    lines.add(clientEntity);
  }

  const metadataClients = Array.isArray(metadata.clients) ? metadata.clients : [];
  for (const entry of metadataClients) {
    if (!entry || typeof entry !== 'object') continue;
    const client = entry as Record<string, unknown>;
    const name = typeof client.name === 'string' ? client.name.trim() : '';
    const email = typeof client.email === 'string' ? client.email.trim() : '';
    const company = typeof client.company === 'string' ? client.company.trim() : '';
    const timezone = typeof client.timezone === 'string' ? client.timezone.trim() : '';
    const label = [name || 'Client', email ? `<${email}>` : '', company ? `— ${company}` : '', timezone ? `(${timezone})` : '']
      .filter(Boolean)
      .join(' ');
    if (label.trim()) {
      lines.add(label.trim());
    }
  }

  for (const member of members) {
    if (!member.email && !member.name) {
      continue;
    }
    lines.add(`${member.name || 'Contact'}${member.email ? ` <${member.email}>` : ''}`);
  }

  return [...lines];
}

function formatStoredDate(value: string | null | undefined): string {
  if (!value) {
    return 'Not specified';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
}

function buildSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .filter((term) => {
      if (seen.has(term)) {
        return false;
      }
      seen.add(term);
      return true;
    });
}

function lexicalScore(query: string, candidate: string): number {
  const terms = buildSearchTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  const haystack = candidate.toLowerCase();
  const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  return matches / terms.length;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function splitLongText(text: string, maxChars: number, overlap: number): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf('\n\n', end),
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf('\n', end)
      );
      if (boundary > start + Math.floor(maxChars * 0.55)) {
        end = boundary;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function chunkSource(source: ProjectMemorySource): Array<{ chunkIndex: number; content: string }> {
  const content = normalizeWhitespace(source.content);
  if (!content) {
    return [];
  }

  if (source.sourceType !== 'document') {
    return [{ chunkIndex: 0, content }];
  }

  return splitLongText(content, DOC_CHUNK_SIZE, DOC_CHUNK_OVERLAP).map((chunk, index) => ({
    chunkIndex: index,
    content: chunk,
  }));
}

function createDesiredChunk(projectId: string, userId: string, source: ProjectMemorySource, chunkIndex: number, content: string): DesiredChunk {
  return {
    id: randomUUID(),
    projectId,
    userId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle,
    chunkIndex,
    content,
    contentHash: hashContent(content),
    metadata: source.metadata,
  };
}

function buildChunkKey(sourceType: ProjectMemorySourceType, sourceId: string, chunkIndex: number): string {
  return `${sourceType}:${sourceId}:${chunkIndex}`;
}

function formatSourceType(sourceType: ProjectMemorySourceType): string {
  if (sourceType === 'project_record') return 'project record';
  if (sourceType === 'email') return 'email thread';
  if (sourceType === 'meeting') return 'meeting note';
  if (sourceType === 'task') return 'task';
  return 'document';
}

function inferSourceTypeBoost(query: string, sourceType: ProjectMemorySourceType): number {
  const lower = query.toLowerCase();
  if (/(proposal|document|file|pdf|attachment|uploaded|scope|pricing|quote|contract)/i.test(lower)) {
    return sourceType === 'document' ? 0.16 : 0;
  }
  if (/(email|thread|reply|sent|received|message)/i.test(lower)) {
    return sourceType === 'email' ? 0.16 : 0;
  }
  if (/(meeting|call|decision|attendees|notes)/i.test(lower)) {
    return sourceType === 'meeting' ? 0.16 : 0;
  }
  if (/(task|todo|deadline|action item|open task|completed)/i.test(lower)) {
    return sourceType === 'task' ? 0.16 : 0;
  }
  if (/(client|milestone|status|owner|team|project)/i.test(lower)) {
    return sourceType === 'project_record' ? 0.1 : 0;
  }
  return 0;
}

async function generateOpenAIEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || texts.length === 0) {
    return texts.map(() => []);
  }

  const allEmbeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += MAX_EMBED_BATCH) {
    const batch = texts.slice(index, index + MAX_EMBED_BATCH);
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        input: batch,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI embeddings request failed with ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };

    const sorted = (payload.data || []).slice().sort((left, right) => (left.index || 0) - (right.index || 0));
    allEmbeddings.push(...sorted.map((item) => normalizeEmbedding(item.embedding || [])));
  }

  return allEmbeddings;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  try {
    return await generateOpenAIEmbeddings(texts);
  } catch (error) {
    console.error('[project-semantic-memory] Embedding generation failed', error);
    return texts.map(() => []);
  }
}

async function loadProjectSources(projectId: string): Promise<{ project: ProjectIdentityRow; sources: ProjectMemorySource[] } | null> {
  const project = await db.queryOne<ProjectIdentityRow>(
    `SELECT id, user_id, name, title, description, summary, status, created_at, linked_contacts, metadata
     FROM projects
     WHERE id = $1`,
    [projectId]
  );

  if (!project) {
    return null;
  }

  const [projectMembers, emailThreads, meetingRows, legacyMeetings, tasks, documents] = await Promise.all([
    db.query<{
      email: string | null;
      name: string | null;
      role: string | null;
      responsibilities: string | null;
      access_level: string | null;
    }>(
      `SELECT email, name, role, responsibilities, access_level
       FROM project_members
       WHERE project_id = $1
       ORDER BY invited_at ASC, name ASC`,
      [projectId]
    ),
    db.query<{
      thread_id: string;
      thread_subject: string | null;
      participants: string | null;
      summary: string;
      reply_needed: boolean;
      reply_urgency: string | null;
      last_message_at: string | null;
    }>(
      `SELECT thread_id, thread_subject, participants, summary, reply_needed, reply_urgency, last_message_at
       FROM project_email_summaries
       WHERE project_id = $1
       ORDER BY last_message_at DESC NULLS LAST, updated_at DESC`,
      [projectId]
    ),
    db.query<{
      id: string;
      title: string | null;
      meeting_date: string | null;
      attendees: string | null;
      summary: string | null;
      decisions: unknown;
      action_items: unknown;
    }>(
      `SELECT id, title, meeting_date, attendees, summary, decisions, action_items
       FROM project_meeting_notes
       WHERE project_id = $1
       ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
      [projectId]
    ),
    db.query<{
      id: string;
      title: string | null;
      meeting_date: string | null;
      content: string | null;
    }>(
      `SELECT id, title, meeting_date, content
       FROM client_meeting_notes
       WHERE project_id = $1
       ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
      [projectId]
    ),
    db.query<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      due_at: string | null;
      completed_at: string | null;
      created_at: string;
    }>(
      `SELECT id, title, description, status::text as status, priority::text as priority, due_at, completed_at, created_at
       FROM todo
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [projectId]
    ),
    db.query<{
      id: string;
      file_name: string;
      file_type: string | null;
      summary: string | null;
      full_text: string | null;
      storage_provider: string | null;
      created_at: string;
    }>(
      `SELECT id, file_name, file_type, summary, full_text, storage_provider, created_at
       FROM project_documents
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    ),
  ]);

  const metadata = (project.metadata || {}) as ProjectMetadata;
  const clients = collectClientLines(project, projectMembers);
  const milestones = Array.isArray(metadata.milestones)
    ? metadata.milestones
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) =>
          [
            typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Milestone',
            typeof entry.targetDate === 'string' && entry.targetDate.trim() ? `Target: ${entry.targetDate.trim()}` : '',
            typeof entry.status === 'string' && entry.status.trim() ? `Status: ${entry.status.trim()}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        )
    : [];

  const sources: ProjectMemorySource[] = [];
  const projectTitle = project.title || project.name || 'Untitled project';

  sources.push({
    sourceType: 'project_record',
    sourceId: project.id,
    sourceTitle: projectTitle,
    content: [
      `Project: ${projectTitle}`,
      `Description: ${project.description || 'Not specified'}`,
      `AI summary: ${project.summary || 'Not specified'}`,
      `Status: ${project.status || 'unknown'}`,
      `Project type: ${readMetadataString(metadata, 'projectType') || 'Not specified'}`,
      `Started: ${formatStoredDate(readMetadataString(metadata, 'startDate') || project.created_at)}`,
      `Target completion: ${formatStoredDate(readMetadataString(metadata, 'targetCompletion'))}`,
      `Engagement value: ${readMetadataString(metadata, 'engagementValue') || 'Not specified'}`,
      `Project owner: ${readMetadataString(metadata, 'projectOwner') || 'Not specified'}`,
      clients.length > 0 ? `Clients:\n${clients.map((line) => `- ${line}`).join('\n')}` : 'Clients: Not specified',
      milestones.length > 0 ? `Milestones:\n${milestones.map((line) => `- ${line}`).join('\n')}` : 'Milestones: Not specified',
      projectMembers.length > 0
        ? `Team roster:\n${projectMembers
            .map((member) =>
              [
                `${member.name || 'Unnamed'}${member.email ? ` <${member.email}>` : ''}`,
                member.role || '',
                member.responsibilities || '',
                member.access_level ? `Access: ${member.access_level}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            )
            .map((line) => `- ${line}`)
            .join('\n')}`
        : 'Team roster: No team members yet.',
    ].join('\n'),
    metadata: {
      createdAt: project.created_at,
      clientCount: clients.length,
      milestoneCount: milestones.length,
    },
  });

  for (const thread of emailThreads) {
    const subject = thread.thread_subject || 'Email thread';
    sources.push({
      sourceType: 'email',
      sourceId: thread.thread_id,
      sourceTitle: subject,
      content: [
        `Subject: ${subject}`,
        `Participants: ${thread.participants || 'Not recorded'}`,
        `Last message at: ${thread.last_message_at || 'Not recorded'}`,
        thread.reply_needed ? `Reply needed: ${thread.reply_urgency || 'unspecified'}` : 'Reply needed: no',
        `Summary: ${thread.summary}`,
      ].join('\n'),
      metadata: {
        participants: thread.participants || null,
        lastMessageAt: thread.last_message_at || null,
        replyNeeded: thread.reply_needed,
        replyUrgency: thread.reply_urgency || null,
      },
    });
  }

  for (const meeting of meetingRows) {
    const title = meeting.title || 'Meeting';
    sources.push({
      sourceType: 'meeting',
      sourceId: meeting.id,
      sourceTitle: title,
      content: [
        `Title: ${title}`,
        `Meeting date: ${meeting.meeting_date || 'Not recorded'}`,
        `Attendees: ${meeting.attendees || 'Not recorded'}`,
        `Summary: ${meeting.summary || 'No summary recorded.'}`,
        normalizeStringArray(meeting.decisions).length > 0 ? `Decisions: ${normalizeStringArray(meeting.decisions).join(' · ')}` : '',
        normalizeStringArray(meeting.action_items).length > 0 ? `Action items: ${normalizeStringArray(meeting.action_items).join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      metadata: {
        meetingDate: meeting.meeting_date || null,
        attendees: meeting.attendees || null,
      },
    });
  }

  for (const meeting of legacyMeetings) {
    const title = meeting.title || 'Meeting';
    sources.push({
      sourceType: 'meeting',
      sourceId: `legacy:${meeting.id}`,
      sourceTitle: title,
      content: [
        `Title: ${title}`,
        `Meeting date: ${meeting.meeting_date || 'Not recorded'}`,
        `Summary: ${meeting.content || 'No notes recorded.'}`,
      ].join('\n'),
      metadata: {
        meetingDate: meeting.meeting_date || null,
        legacy: true,
      },
    });
  }

  for (const task of tasks) {
    sources.push({
      sourceType: 'task',
      sourceId: task.id,
      sourceTitle: task.title,
      content: [
        `Task: ${task.title}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Due: ${task.due_at || 'Not specified'}`,
        `Completed: ${task.completed_at || 'Not completed'}`,
        `Details: ${task.description || 'No extra detail provided.'}`,
      ].join('\n'),
      metadata: {
        status: task.status,
        priority: task.priority,
        dueAt: task.due_at || null,
        completedAt: task.completed_at || null,
        createdAt: task.created_at,
      },
    });
  }

  for (const document of documents) {
    const summary = document.summary?.trim() || 'No summary available.';
    const fullText = document.full_text?.trim() || '';
    const content = [
      `Document: ${document.file_name}`,
      `File type: ${document.file_type || 'unknown'}`,
      `Storage: ${document.storage_provider || 'local'}`,
      `Created at: ${document.created_at}`,
      `Summary: ${summary}`,
      fullText ? `Extracted text:\n${fullText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    sources.push({
      sourceType: 'document',
      sourceId: document.id,
      sourceTitle: document.file_name,
      content,
      metadata: {
        fileType: document.file_type || null,
        storageProvider: document.storage_provider || null,
        createdAt: document.created_at,
        hasFullText: Boolean(fullText),
        summary,
      },
    });
  }

  return { project, sources };
}

export async function refreshProjectSemanticMemory(projectId: string, force = false): Promise<void> {
  await ensureAssistantRuntimeTables();

  const now = Date.now();
  const lastRefreshed = refreshTimestamps.get(projectId) || 0;
  if (!force && now - lastRefreshed < PROJECT_REFRESH_TTL_MS) {
    return;
  }

  const loaded = await loadProjectSources(projectId);
  if (!loaded) {
    return;
  }

  const desiredChunks = loaded.sources.flatMap((source) =>
    chunkSource(source).map(({ chunkIndex, content }) => createDesiredChunk(projectId, loaded.project.user_id, source, chunkIndex, content))
  );

  const existingRows = await db.query<ProjectMemoryChunkRow>(
    `SELECT id, project_id, user_id, source_type, source_id, source_title, chunk_index, content, embedding, content_hash, metadata
     FROM project_memory_chunks
     WHERE project_id = $1`,
    [projectId]
  );

  const existingByKey = new Map<string, ProjectMemoryChunkRow>(
    existingRows.map((row) => [buildChunkKey(row.source_type, row.source_id, row.chunk_index), row] as const)
  );
  const desiredKeys = new Set<string>(desiredChunks.map((chunk) => buildChunkKey(chunk.sourceType, chunk.sourceId, chunk.chunkIndex)));

  const changedChunks = desiredChunks.filter((chunk) => {
    const existing = existingByKey.get(buildChunkKey(chunk.sourceType, chunk.sourceId, chunk.chunkIndex));
    return !existing || existing.content_hash !== chunk.contentHash || existing.source_title !== chunk.sourceTitle;
  });

  const embeddings = await embedTexts(changedChunks.map((chunk) => chunk.content));

  for (let index = 0; index < desiredChunks.length; index += 1) {
    const chunk = desiredChunks[index];
    const key = buildChunkKey(chunk.sourceType, chunk.sourceId, chunk.chunkIndex);
    const existing = existingByKey.get(key);
    const changedIndex = changedChunks.findIndex(
      (candidate) =>
        candidate.sourceType === chunk.sourceType &&
        candidate.sourceId === chunk.sourceId &&
        candidate.chunkIndex === chunk.chunkIndex
    );
    const embedding = changedIndex >= 0 ? embeddings[changedIndex] || [] : normalizeEmbedding(existing?.embedding);

    if (!existing) {
      await db.query(
        `INSERT INTO project_memory_chunks (
           id, project_id, user_id, source_type, source_id, source_title, chunk_index, content, embedding, content_hash, metadata, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, NOW(), NOW())`,
        [
          chunk.id,
          chunk.projectId,
          chunk.userId,
          chunk.sourceType,
          chunk.sourceId,
          chunk.sourceTitle,
          chunk.chunkIndex,
          chunk.content,
          JSON.stringify(embedding),
          chunk.contentHash,
          JSON.stringify(chunk.metadata),
        ]
      );
      continue;
    }

    if (changedIndex >= 0) {
      await db.query(
        `UPDATE project_memory_chunks
         SET source_title = $2,
             content = $3,
             embedding = $4::jsonb,
             content_hash = $5,
             metadata = $6::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.id,
          chunk.sourceTitle,
          chunk.content,
          JSON.stringify(embedding),
          chunk.contentHash,
          JSON.stringify(chunk.metadata),
        ]
      );
      continue;
    }

    if (JSON.stringify(existing.metadata || {}) !== JSON.stringify(chunk.metadata)) {
      await db.query(
        `UPDATE project_memory_chunks
         SET metadata = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, JSON.stringify(chunk.metadata)]
      );
    }
  }

  const staleIds = existingRows
    .filter((row) => !desiredKeys.has(buildChunkKey(row.source_type, row.source_id, row.chunk_index)))
    .map((row) => row.id);

  if (staleIds.length > 0) {
    await db.query(`DELETE FROM project_memory_chunks WHERE id = ANY($1::text[])`, [staleIds]);
  }

  refreshTimestamps.set(projectId, now);
}

export async function purgeProjectSemanticSource(projectId: string, sourceType: ProjectMemorySourceType, sourceId: string): Promise<void> {
  await ensureAssistantRuntimeTables();
  await db.query(
    `DELETE FROM project_memory_chunks
     WHERE project_id = $1 AND source_type = $2 AND source_id = $3`,
    [projectId, sourceType, sourceId]
  );
  refreshTimestamps.delete(projectId);
}

export async function searchProjectMemory(params: {
  projectId: string;
  query: string;
  topK?: number;
  sourceTypes?: ProjectMemorySourceType[];
  refresh?: boolean;
}): Promise<ProjectMemoryHit[]> {
  if (!params.query.trim()) {
    return [];
  }

  await refreshProjectSemanticMemory(params.projectId, params.refresh);

  const rows = await db.query<ProjectMemoryChunkRow>(
    params.sourceTypes?.length
      ? `SELECT id, project_id, user_id, source_type, source_id, source_title, chunk_index, content, embedding, content_hash, metadata
         FROM project_memory_chunks
         WHERE project_id = $1 AND source_type = ANY($2::text[])`
      : `SELECT id, project_id, user_id, source_type, source_id, source_title, chunk_index, content, embedding, content_hash, metadata
         FROM project_memory_chunks
         WHERE project_id = $1`,
    params.sourceTypes?.length ? [params.projectId, params.sourceTypes] : [params.projectId]
  );

  if (rows.length === 0) {
    return [];
  }

  const queryEmbedding = (await embedTexts([params.query]))[0] || [];
  const terms = buildSearchTerms(params.query);
  const sourceCounts = new Map<string, number>();
  const scored = rows
    .map((row) => {
      const candidateText = `${row.source_title}\n${row.content}`;
      const lexical = lexicalScore(params.query, candidateText);
      const similarity = cosineSimilarity(queryEmbedding, normalizeEmbedding(row.embedding));
      const sourceBoost = inferSourceTypeBoost(params.query, row.source_type);
      const keywordBoost =
        terms.length > 0 && terms.some((term) => row.source_title.toLowerCase().includes(term)) ? 0.08 : 0;
      const score = similarity * 0.72 + lexical * 0.2 + sourceBoost + keywordBoost;
      return {
        id: row.id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceTitle: row.source_title,
        chunkIndex: row.chunk_index,
        content: row.content,
        score,
        similarity,
        lexicalScore: lexical,
        metadata: (row.metadata || {}) as Record<string, unknown>,
      } satisfies ProjectMemoryHit;
    })
    .filter((hit) => hit.score > 0 || hit.lexicalScore > 0 || hit.similarity > 0)
    .sort((left, right) => right.score - left.score);

  const limited: ProjectMemoryHit[] = [];
  for (const hit of scored) {
    const key = `${hit.sourceType}:${hit.sourceId}`;
    const seen = sourceCounts.get(key) || 0;
    if (seen >= 2) {
      continue;
    }
    sourceCounts.set(key, seen + 1);
    limited.push(hit);
    if (limited.length >= (params.topK || 8)) {
      break;
    }
  }

  return limited;
}

export function buildProjectMemoryEvidence(hits: ProjectMemoryHit[], maxSources = 6): ProjectMemoryEvidence[] {
  const grouped = new Map<string, ProjectMemoryEvidence>();

  for (const hit of hits) {
    const key = `${hit.sourceType}:${hit.sourceId}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        label: '',
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        sourceTitle: hit.sourceTitle,
        score: hit.score,
        metadata: hit.metadata,
        excerpts: [hit.content],
      });
      continue;
    }

    existing.score = Math.max(existing.score, hit.score);
    if (existing.excerpts.length < 2 && !existing.excerpts.includes(hit.content)) {
      existing.excerpts.push(hit.content);
    }
  }

  return [...grouped.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSources)
    .map((entry, index) => ({
      ...entry,
      label: `S${index + 1}`,
    }));
}

function buildEvidenceBlock(question: string, evidence: ProjectMemoryEvidence[], recentConversation: string): string {
  return [
    `User question: ${question}`,
    recentConversation ? `Recent conversation:\n${recentConversation}` : '',
    evidence.length > 0
      ? `Grounding evidence:\n${evidence
          .map(
            (entry) =>
              `[${entry.label}] ${formatSourceType(entry.sourceType)} — ${entry.sourceTitle}\n${entry.excerpts.join('\n\n')}`
          )
          .join('\n\n')}`
      : 'Grounding evidence: none.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildSourcesSection(evidence: ProjectMemoryEvidence[]): string {
  if (evidence.length === 0) {
    return '';
  }

  return `Sources:\n${evidence
    .map((entry) => `- [${entry.label}] ${formatSourceType(entry.sourceType)} — ${entry.sourceTitle}`)
    .join('\n')}`;
}

function buildFallbackProjectAnswer(question: string, evidence: ProjectMemoryEvidence[]): string {
  if (evidence.length === 0) {
    return `I could not find grounded project memory for "${question}" yet. Sync the project or upload material with extractable text first.`;
  }

  const facts = evidence
    .slice(0, 3)
    .map((entry) => `- [${entry.label}] ${entry.sourceTitle}: ${entry.excerpts[0].replace(/\s+/g, ' ').slice(0, 280)}`)
    .join('\n');

  return `${facts}\n\n${buildSourcesSection(evidence)}`.trim();
}

export async function answerProjectQuestion(params: {
  projectId: string;
  question: string;
  recentConversation?: string;
}): Promise<{ reply: string; evidence: ProjectMemoryEvidence[] }> {
  await refreshProjectSemanticMemory(params.projectId, true);

  const hits = await searchProjectMemory({
    projectId: params.projectId,
    query: params.question,
    topK: 10,
    refresh: false,
  });
  const evidence = buildProjectMemoryEvidence(hits, 6);

  if (evidence.length === 0) {
    return {
      reply: buildFallbackProjectAnswer(params.question, evidence),
      evidence,
    };
  }

  try {
    const reply = await generateText({
      system:
        'You are the project assistant. Answer only from the supplied project memory evidence. Use normal prose, not JSON. Every substantive factual statement must include one or more citations like [S1]. If the evidence is incomplete, say so clearly. Do not create tasks, recommendations, or next steps unless the user explicitly asked for them. Keep the answer concise but complete enough to directly answer the question.',
      messages: [
        {
          role: 'user',
          content: buildEvidenceBlock(params.question, evidence, params.recentConversation || ''),
        },
      ],
      maxTokens: 1_000,
      temperature: 0.1,
    });

    const sourcesSection = buildSourcesSection(evidence);
    return {
      reply: sourcesSection && !/\bSources:\b/i.test(reply) ? `${reply.trim()}\n\n${sourcesSection}` : reply.trim(),
      evidence,
    };
  } catch (error) {
    console.error('[project-semantic-memory] Grounded project answer failed', error);
    return {
      reply: buildFallbackProjectAnswer(params.question, evidence),
      evidence,
    };
  }
}
