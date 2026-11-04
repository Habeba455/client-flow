import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PROMPT_CONFIG, resolvePromptIntro, SPECIAL_PROMPT_CONFIG, type SpecialPrompt } from '@/lib/ai/agent-config';
import type { AgentName, PersonaIntros, RoutingTask } from '@/lib/ai/types';

const PROMPT_FILE = 'AI_Assistant_Master_v4_COMPLETE.md';
const promptCache = new Map<string, string>();

function getPromptFilePath(): string {
  return path.join(process.cwd(), PROMPT_FILE);
}

function extractBlockByHeading(fullText: string, heading: string): string {
  const normalized = fullText.replace(/\r\n/g, '\n');
  const startPattern = new RegExp(`^# ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');
  const startMatch = normalized.match(startPattern);
  if (!startMatch || startMatch.index == null) {
    return '';
  }

  const start = startMatch.index + startMatch[0].length;
  const rest = normalized.slice(start);
  const nextMatch = rest.match(/^# (?:PROMPT \d+:|SECTION \d+:).*$/m);
  const end = nextMatch?.index != null ? start + nextMatch.index : normalized.length;
  const section = normalized.slice(start, end).trim();

  const lines = section.split('\n');
  const firstFenceIndex = lines.findIndex((line) => line.trim().startsWith('```'));
  const lastFenceIndex =
    firstFenceIndex >= 0
      ? [...lines].reverse().findIndex((line) => line.trim() === '```')
      : -1;

  if (firstFenceIndex >= 0 && lastFenceIndex >= 0) {
    const closeIndex = lines.length - lastFenceIndex - 1;
    if (closeIndex > firstFenceIndex) {
      return lines.slice(firstFenceIndex + 1, closeIndex).join('\n').trim();
    }
  }

  return section;
}

function readPromptCache(key: string, heading: string): string {
  if (promptCache.has(key)) {
    return promptCache.get(key) ?? '';
  }

  const fullText = fs.readFileSync(getPromptFilePath(), 'utf8');
  const content = extractBlockByHeading(fullText, heading);
  promptCache.set(key, content);
  return content;
}

export function getMasterPrompt(promptNumber: number): string {
  return readPromptCache(`prompt:${promptNumber}`, `PROMPT ${promptNumber}:`);
}

export function getSpecialPrompt(name: SpecialPrompt): string {
  return getMasterPrompt(SPECIAL_PROMPT_CONFIG[name].promptNumber);
}

export function applyPersonaIntro(promptBody: string, intro: string | null | undefined): string {
  const cleanIntro = intro?.trim();
  if (!cleanIntro) {
    return promptBody.replace(/^\s*\[[A-Z_]+_INTRO\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  return promptBody.replace(/^\s*\[[A-Z_]+_INTRO\]\s*$/gm, cleanIntro).replace(/\n{3,}/g, '\n\n').trim();
}

export function buildAgentPrompt(agent: AgentName, task: RoutingTask | null | undefined, intros: PersonaIntros | null): string {
  const basePrompt = getMasterPrompt(AGENT_PROMPT_CONFIG[agent].promptNumber);
  const intro = resolvePromptIntro(agent, task, intros);
  return applyPersonaIntro(basePrompt, intro);
}
