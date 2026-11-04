import type { AgentName, DeferredActionType, PersonaIntros, RoutingTask } from '@/lib/ai/types';
import { getAnthropicSpecModel, type AnthropicModelTier } from '@/lib/ai/spec-models';

export type ModelTier = AnthropicModelTier;
export type SpecialPrompt = 'SETTINGS_AGENT' | 'PERSONA_INTRO_GENERATOR' | 'ORCHESTRATOR';

export interface AgentPromptConfig {
  promptNumber: number;
  modelTier: ModelTier;
  maxTokens: number;
  temperature: number;
  injectIntro?: 'business' | 'executive' | 'partner' | 'partner_runtime' | 'document_runtime';
}

export interface SpecialPromptConfig {
  promptNumber: number;
  modelTier: ModelTier;
  maxTokens: number;
  temperature: number;
}

export const SPECIAL_PROMPT_CONFIG: Record<SpecialPrompt, SpecialPromptConfig> = {
  SETTINGS_AGENT: { promptNumber: 2, modelTier: 'sonnet', maxTokens: 2000, temperature: 0.3 },
  PERSONA_INTRO_GENERATOR: { promptNumber: 3, modelTier: 'sonnet', maxTokens: 1000, temperature: 0.3 },
  ORCHESTRATOR: { promptNumber: 4, modelTier: 'opus', maxTokens: 500, temperature: 0.1 },
};

export const AGENT_PROMPT_CONFIG: Record<AgentName, AgentPromptConfig> = {
  BUSINESS_ANALYST: { promptNumber: 5, modelTier: 'opus', maxTokens: 4000, temperature: 0.4, injectIntro: 'business' },
  EXECUTIVE_ASSISTANT: { promptNumber: 6, modelTier: 'sonnet', maxTokens: 1500, temperature: 0.4, injectIntro: 'executive' },
  MANAGING_PARTNER: { promptNumber: 7, modelTier: 'opus', maxTokens: 2000, temperature: 0.5, injectIntro: 'partner' },
  PROJECT_COORDINATOR: { promptNumber: 8, modelTier: 'sonnet', maxTokens: 1500, temperature: 0.2 },
  TASK_ASSIGNMENT: { promptNumber: 9, modelTier: 'sonnet', maxTokens: 2000, temperature: 0.3 },
  CONTRACT_INTELLIGENCE: { promptNumber: 10, modelTier: 'opus', maxTokens: 4000, temperature: 0.2 },
  DEAL_FINANCIAL_ANALYSIS: { promptNumber: 11, modelTier: 'opus', maxTokens: 4000, temperature: 0.2 },
  EMAIL_ANALYST: { promptNumber: 12, modelTier: 'sonnet', maxTokens: 1500, temperature: 0.3 },
  EMAIL_SENDER: { promptNumber: 13, modelTier: 'sonnet', maxTokens: 600, temperature: 0.4, injectIntro: 'partner_runtime' },
  CALENDAR_AGENT: { promptNumber: 14, modelTier: 'sonnet', maxTokens: 500, temperature: 0.2 },
  DOCUMENT_GENERATOR: { promptNumber: 15, modelTier: 'opus', maxTokens: 4000, temperature: 0.4, injectIntro: 'document_runtime' },
  INVOICE_GENERATOR: { promptNumber: 16, modelTier: 'sonnet', maxTokens: 1000, temperature: 0.2 },
  RECEIPT_EXTRACTOR: { promptNumber: 17, modelTier: 'opus', maxTokens: 800, temperature: 0.1 },
  RESEARCH_AGENT: { promptNumber: 18, modelTier: 'opus', maxTokens: 4000, temperature: 0.1 },
};

export const ALL_AGENT_NAMES = Object.keys(AGENT_PROMPT_CONFIG) as AgentName[];

export function getAnthropicModelForTier(tier: ModelTier): string {
  return getAnthropicSpecModel(tier);
}

export function shouldRequireApproval(task: RoutingTask): boolean {
  const deliverable = typeof task.context.deliverable_type === 'string' ? task.context.deliverable_type.toLowerCase() : '';
  const external = typeof task.context.external === 'boolean' ? task.context.external : false;

  if (task.persona === 'EMAIL_SENDER') return true;
  if (task.persona === 'INVOICE_GENERATOR' && external) return true;
  if (task.persona === 'DOCUMENT_GENERATOR' && external) return true;
  return ['invoice', 'calendar_invite', 'proposal', 'pdf', 'word_doc', 'spreadsheet', 'powerpoint'].includes(deliverable) && external;
}

export function inferDeferredActionType(task: RoutingTask): DeferredActionType | null {
  if (task.persona === 'EMAIL_SENDER') return 'email';
  if (task.persona === 'CALENDAR_AGENT') return 'calendar_event';
  if (task.persona === 'INVOICE_GENERATOR') return 'invoice_send';
  if (task.persona === 'DOCUMENT_GENERATOR') return 'save_to_project_documents';
  return null;
}

export function resolvePromptIntro(
  agent: AgentName,
  task: RoutingTask | null | undefined,
  intros: PersonaIntros | null
): string | null {
  const rule = AGENT_PROMPT_CONFIG[agent].injectIntro;
  if (!rule || !intros) {
    return null;
  }

  if (rule === 'business') return intros.businessAnalystIntro;
  if (rule === 'executive') return intros.executiveAssistantIntro;
  if (rule === 'partner' || rule === 'partner_runtime') return intros.managingPartnerIntro;

  const deliverable = typeof task?.context?.deliverable_type === 'string' ? task.context.deliverable_type.toLowerCase() : '';
  if (['proposal', 'research', 'report', 'word_doc', 'pdf', 'powerpoint'].includes(deliverable)) {
    return intros.businessAnalystIntro;
  }
  if (['strategy', 'board_memo', 'thought_leadership'].includes(deliverable)) {
    return intros.managingPartnerIntro;
  }
  return null;
}
