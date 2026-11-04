export type AgentName =
  | 'BUSINESS_ANALYST'
  | 'EXECUTIVE_ASSISTANT'
  | 'MANAGING_PARTNER'
  | 'PROJECT_COORDINATOR'
  | 'TASK_ASSIGNMENT'
  | 'CONTRACT_INTELLIGENCE'
  | 'DEAL_FINANCIAL_ANALYSIS'
  | 'EMAIL_ANALYST'
  | 'EMAIL_SENDER'
  | 'CALENDAR_AGENT'
  | 'DOCUMENT_GENERATOR'
  | 'INVOICE_GENERATOR'
  | 'RECEIPT_EXTRACTOR'
  | 'RESEARCH_AGENT';

export type AssistantMode = 'onboarding' | 'assistant';

export type SurfaceName =
  | 'dashboard'
  | 'assistant'
  | 'email_hub'
  | 'projects'
  | 'project_overview'
  | 'project_documents'
  | 'project_todos'
  | 'project_assistant'
  | 'project_finance'
  | 'tasks'
  | 'calendar'
  | 'automations'
  | 'linkedin'
  | 'settings';

export interface UserProfile {
  firm_name: string | null;
  firm_description: string | null;
  primary_industry: string | null;
  secondary_industries: string[];
  firm_size: string | null;
  services: string[];
  client_profile: string | null;
  client_problems: string[];
  credentials: string[];
  geography: string[];
  positioning: string | null;
  contact_email: string | null;
  contact_website: string | null;
  address?: string | null;
  user_timezone?: string | null;
  working_hours_start?: string | null;
  working_hours_end?: string | null;
}

export interface PersonaIntros {
  businessAnalystIntro: string;
  executiveAssistantIntro: string;
  managingPartnerIntro: string;
}

export interface UploadedAttachmentMeta {
  id?: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  url?: string | null;
  source?: 'upload' | 'email' | 'drive';
  /** Client-only handle to the picked file; never sent to the server. */
  file?: File;
}

export interface AttachmentToIngest {
  name: string;
  mime_type?: string | null;
  source_url?: string | null;
  thread_id?: string | null;
  project_id?: string | null;
}

export type DeferredActionType =
  | 'email'
  | 'calendar_event'
  | 'save_to_drive'
  | 'save_to_project_documents'
  | 'invoice_send'
  | 'other';

export interface DeferredAction {
  id?: string;
  action_type: DeferredActionType;
  title?: string | null;
  recipient_email?: string | null;
  recipient_name?: string | null;
  drive_folder?: string | null;
  payload?: Record<string, unknown>;
}

export interface RoutingTask {
  id?: string;
  persona: AgentName;
  subtask: string;
  context: Record<string, unknown>;
  depends_on: string | null;
}

export interface RoutingDecision {
  complexity: 'SIMPLE' | 'MODERATE' | 'COMPLEX';
  primary_persona: AgentName;
  routing: RoutingTask[];
  merge_instruction: string | null;
  requires_approval: boolean;
  deferred_actions: DeferredAction[];
  attachments_to_ingest: AttachmentToIngest[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  metadata?: {
    mode?: AssistantMode;
    persona?: AgentName;
    surface?: SurfaceName;
    projectId?: string | null;
    error?: string;
    pendingApprovalIds?: string[];
    scheduling?: {
      kind: 'availability_options' | 'selected_slot_confirmation';
      clientName?: string | null;
      clientEmail?: string | null;
      clientTimezone?: string | null;
      title?: string | null;
      description?: string | null;
      durationMinutes?: number | null;
      options?: Array<{
        option: number;
        start: string;
        end: string;
        userDisplayTime: string;
        clientDisplayTime: string;
      }>;
      selectedOption?: {
        option: number;
        start: string;
        end: string;
        userDisplayTime: string;
        clientDisplayTime: string;
      } | null;
    };
    projectSetup?: {
      kind: 'project_creation';
      fields: {
        projectName?: string | null;
        clientEntity?: string | null;
        description?: string | null;
        projectType?: string | null;
        startDate?: string | null;
        targetCompletion?: string | null;
        engagementValue?: string | null;
        projectOwner?: string | null;
        status?: string | null;
        milestones?: Array<{
          title: string;
          targetDate: string | null;
          status: string;
        }>;
        teamRoster?: Array<{
          name: string;
          email: string;
          role: string | null;
          responsibilities: string | null;
          accessLevel: string | null;
        }>;
      };
      awaitingField?: 'projectName' | 'clientEntity' | 'description' | 'startDate' | 'targetCompletion';
    };
    projectInvite?: {
      kind: 'team_invite';
      projectId: string | null;
      projectName: string;
      awaiting: 'prompt_confirmation' | 'member_details';
    };
  };
}

export interface WorkspaceArtifact {
  id: string;
  kind: 'project_record' | 'task_assignment' | 'deliverable' | 'draft_reply' | 'calendar_plan' | 'invoice' | 'research'| 'receipt';
  title: string;
  project: string | null;
  persona: AgentName;
  content: string;
  createdAt: string;
  approvalActionId?: string | null;
}

export interface WorkspaceState {
  artifacts: WorkspaceArtifact[];
}

export interface AgentRunResult {
  id: string;
  persona: AgentName;
  subtask: string;
  context: Record<string, unknown>;
  depends_on: string | null;
  output: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  projectId: string | null;
}

export interface AssistantConversation {
  id: string;
  title: string;
  updatedAt: string;
  projectId: string | null;
  messages: ChatMessage[];
}

export type ApprovalStatus =
  | 'PENDING_GENERATION'
  | 'AWAITING_APPROVAL'
  | 'EDITING'
  | 'APPROVED'
  | 'ACTION_IN_PROGRESS'
  | 'COMPLETED'
  | 'REJECTED';

export interface ApprovalAction {
  id: string;
  title: string;
  status: ApprovalStatus;
  actionType: DeferredActionType;
  projectId: string | null;
  conversationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantRequest {
  message: string;
  conversationId?: string | null;
  projectId?: string | null;
  history: ChatMessage[];
  mode: AssistantMode;
  surface?: SurfaceName;
  workspace: WorkspaceState | null;
  attachments?: UploadedAttachmentMeta[];
}

export interface AssistantResponse {
  mode: AssistantMode;
  reply: string;
  profile: UserProfile | null;
  workspace: WorkspaceState;
  conversation: AssistantConversation;
  conversations: AssistantConversationSummary[];
  pendingApprovals: ApprovalAction[];
  route: RoutingDecision | null;
}

export interface AssistantWorkspaceUser {
  id: string;
  name: string | null;
  email: string;
}
