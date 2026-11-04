"use client";
import ReceiptReview from "./receipt-review"
import { useState, useEffect, useMemo, useRef, FormEvent, KeyboardEvent } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, Paperclip, Plus, Sparkles, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  ApprovalAction,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantMode,
  AssistantResponse,
  SurfaceName,
  UploadedAttachmentMeta,
  UserProfile,
  WorkspaceState,
} from "@/lib/ai/types";

type AssistantStreamEvent =
  | { type: "status"; phase: string; message: string }
  | { type: "result"; data: AssistantResponse }
  | { type: "error"; error: string };

const STARTER_PROMPTS = [
  {
    title: "Write a proposal",
    description: "for a new client engagement",
    prompt: "Write a proposal for a new client engagement",
  },
  {
    title: "Create an invoice",
    description: "with line items and payment terms",
    prompt: "Create an invoice with line items and payment terms",
  },
  {
    title: "Review a contract",
    description: "identify risks and negotiation points",
    prompt: "Review a contract and list the main negotiation risks",
  },
  {
    title: "Set up a project",
    description: "with team members and milestones",
    prompt: "Set up a project with team members and milestones",
  },
] as const;

function getMarkdownAnchorProps(href?: string) {
  const link = href || "";

  const isProposal = link.startsWith("/api/proposals/");
  const isGeneratedFile = link.startsWith("/api/generated-files/");
  const isExternal = /^https?:\/\//i.test(link);

  const isAction = isProposal;

  return {
    className: isAction ? "markdown-action-link" : undefined,
    target: isProposal || isExternal ? "_blank" : undefined,
    rel: isProposal || isExternal ? "noreferrer" : undefined,
    download: isGeneratedFile ? true : undefined,
  };
}

function createStarterMessages(
  mode: AssistantMode,
  profile: UserProfile | null
): AssistantConversation["messages"] {
  if (mode === "onboarding") {
    return [
      {
        id: "starter-onboarding",
        role: "assistant",
        content:
          "Settings Agent is ready. I will ask one focused question at a time so your assistant can be calibrated to your firm.",
        createdAt: new Date().toISOString(),
        metadata: { mode: "onboarding", surface: "assistant" },
      },
    ];
  }

  return [
    {
      id: "starter-assistant",
      role: "assistant",
      content: `Your firm profile is loaded for ${profile?.firm_name || "your account"
        }. Describe what you need a proposal, email reply, project update, or schedule and I’ll handle it using your context.`,
      createdAt: new Date().toISOString(),
      metadata: { mode: "assistant", surface: "assistant" },
    },
  ];
}

function isResearchFetchApproval(approval: ApprovalAction): boolean {
  return (
    approval.actionType === "other" &&
    approval.payload?.workflow === "research_fetch"
  );
}

function getApprovalLabels(
  approval: ApprovalAction,
  isPending: boolean
) {
  if (isResearchFetchApproval(approval)) {
    return {
      approve: isPending ? "Fetching..." : "Confirm & fetch",
      reject: "Cancel plan",
    };
  }

  return {
    approve: isPending ? "Working..." : "Approve",
    reject: "Reject",
  };
}


export function AssistantConsole({
  initialMode,
  initialProfile,
  initialConversation,
  conversations,
  pendingApprovals,
  projectId,
  projectName,
  surface,
  basePath,
  initialInput = '',
}: {
  initialMode: AssistantMode;
  initialProfile: UserProfile | null;
  initialConversation: AssistantConversation | null;
  conversations: AssistantConversationSummary[];
  pendingApprovals: ApprovalAction[];
  projectId?: string | null;
  projectName?: string | null;
  surface: SurfaceName;
  basePath: string;
  initialInput?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [mode, setMode] = useState<AssistantMode>(initialMode);
  const [profile, setProfile] = useState<UserProfile | null>(initialProfile);
  const [conversation, setConversation] = useState<AssistantConversation | null>(initialConversation);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ artifacts: [] });
  const [conversationList, setConversationList] = useState<AssistantConversationSummary[]>(conversations);
  const [approvals, setApprovals] = useState<ApprovalAction[]>(pendingApprovals);
  const [input, setInput] = useState(initialInput);
  const [attachments, setAttachments] = useState<UploadedAttachmentMeta[]>([]);
  const [pending, setPending] = useState(false);
  const [progressUpdates, setProgressUpdates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
  const [approvalResult, setApprovalResult] = useState<string | null>(null);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [researchPlanDraft, setResearchPlanDraft] = useState('');
  const [conversationToDelete, setConversationToDelete] = useState<AssistantConversationSummary | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const lastSyncedConversationIdRef = useRef<string | null>(initialConversation?.id || null);
  const [receipt, setReceipt] = useState<any | null>(null)

  const messages = conversation?.messages || createStarterMessages(mode, profile);
  const incomingConversationId = initialConversation?.id || null;
  const derivedProjectId =
  projectId ||
  conversation?.projectId ||
  pathname.match(/^\/projects\/([^/]+)/)?.[1] ||
  null;

  useEffect(() => {
    if (incomingConversationId === conversation?.id) {
      lastSyncedConversationIdRef.current = incomingConversationId;
      return;
    }

    if (lastSyncedConversationIdRef.current === incomingConversationId) {
      return;
    }

    lastSyncedConversationIdRef.current = incomingConversationId;
    setMode(initialMode);
    setProfile(initialProfile);
    setConversation(initialConversation);
    setWorkspace({ artifacts: [] });
    setAttachments([]);
    setError(null);
    setProgressUpdates([]);
    setApprovalResult(null);
  }, [conversation?.id, incomingConversationId, initialConversation, initialMode, initialProfile]);

  useEffect(() => {
    setInput(initialInput);
  }, [initialInput]);

  useEffect(() => {
    setConversationList(conversations);
  }, [conversations]);

  useEffect(() => {
    setApprovals(pendingApprovals);
  }, [pendingApprovals]);

  const headerSubtitle = useMemo(() => {
    if (projectName) {
      return `Project-scoped assistant for ${projectName}`;
    }
    return mode === 'assistant'
      ? 'Powered by ClientFlow AI. Your requests are handled by the right specialist proposals, emails, tasks, and more using your firm profile.'
      : 'Complete setup so the assistant can personalize proposals, documents, and replies to your firm.';
  }, [mode, projectName]);


    const submitMessage = async (event: FormEvent) => {
      event.preventDefault();
      const message = input.trim();

      if (pending) return;
      const hasReceiptAttachment =
         attachments?.length > 0 && ( attachments[0].mimeType?.startsWith("image") || attachments[0].mimeType === "application/pdf");

      if (hasReceiptAttachment) {
        try {
          setPending(true);
          setError(null);

          const formData = new FormData();
          const pickedFile = attachments[0].file;
          if (!pickedFile) {
            throw new Error("The selected file is no longer available. Please attach it again.");
          }
          formData.append("file", pickedFile);

          const res = await fetch("/api/receipts/extract", {
            method: "POST",
            body: formData,
          });

          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Receipt extraction failed");
          }

          const data = await res.json();

          setReceipt(data);

          setConversation((current) => {
            if (!current) {
              return {
                id: "draft",
                title: "Receipt Review",
                updatedAt: new Date().toISOString(),
                projectId: projectId || null,
                messages: [
                  {
                    id: `assistant_receipt_${Date.now()}`,
                    role: "assistant",
                    content:
                      "I detected a receipt in your upload. Please review and edit the extracted details below before saving it.",
                    createdAt: new Date().toISOString(),
                  },
                ],
              };
            }

            return {
              ...current,
              updatedAt: new Date().toISOString(),
              messages: [
                ...current.messages,
                {
                  id: `assistant_receipt_${Date.now()}`,
                  role: "assistant",
                  content:
                    "I detected a receipt in your upload. Please review and edit the extracted details below before saving it.",
                  createdAt: new Date().toISOString(),
                },
              ],
            };
          });

          setInput("");
          return;
        } catch (submitError) {
          const messageText =
            submitError instanceof Error ? submitError.message : "Receipt extraction failed";
          setError(messageText);
          return;
        } finally {
          setPending(false);
        }
      }

      if (!message) return;

      setPending(true);
      setError(null);
      setProgressUpdates([]);

      const history = conversation?.messages || [];
      const nextHistory = [
        ...history,
        {
          id: `user_${Date.now()}`,
          role: 'user' as const,
          content: message,
          createdAt: new Date().toISOString(),
          metadata: { mode, surface, projectId: derivedProjectId || null },
        },
      ];

      if (conversation) {
        setConversation({ ...conversation, messages: nextHistory, updatedAt: new Date().toISOString() });
      } else {
        setConversation({
          id: 'draft',
          title: message,
          updatedAt: new Date().toISOString(),
          projectId: derivedProjectId || null,
          messages: nextHistory,
        });
      }

      setInput('');

      try {
        const response = await fetch('/api/assistant/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message,
            conversationId: conversation?.id === 'draft' ? null : conversation?.id || null,
            projectId: derivedProjectId || null,
            history,
            mode,
            surface,
            workspace,
            attachments: attachments.map(({ file: _file, ...meta }) => meta),
          }),
        });

        if (response.status === 401) {
          window.location.href = '/auth/signin';
          return;
        }

        if (!response.ok) {
          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('application/json')) {
            const data = (await response.json()) as { error?: string };
            throw new Error(data.error || 'Request failed');
          }
          throw new Error(await response.text());
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/x-ndjson')) {
          throw new Error('Assistant stream did not start correctly.');
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Assistant stream is unavailable in this browser.');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let finalResponse: AssistantResponse | null = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
              const eventData = JSON.parse(line) as AssistantStreamEvent;
              if (eventData.type === 'status') {
                setProgressUpdates((current) => {
                  if (current[current.length - 1] === eventData.message) {
                    return current;
                  }
                  return [...current, eventData.message].slice(-6);
                });
              } else if (eventData.type === 'error') {
                throw new Error(eventData.error || 'Request failed');
              } else {
                finalResponse = eventData.data;
              }
            }
            newlineIndex = buffer.indexOf('\n');
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          const eventData = JSON.parse(buffer.trim()) as AssistantStreamEvent;
          if (eventData.type === 'status') {
            setProgressUpdates((current) => {
              if (current[current.length - 1] === eventData.message) {
                return current;
              }
              return [...current, eventData.message].slice(-6);
            });
          } else if (eventData.type === 'error') {
            throw new Error(eventData.error || 'Request failed');
          } else {
            finalResponse = eventData.data;
          }
        }

        if (!finalResponse) {
          throw new Error('Assistant request ended before a final response was returned.');
        }

        setMode(finalResponse.mode);
        setProfile(finalResponse.profile);
        setWorkspace(finalResponse.workspace);
        setConversation(finalResponse.conversation);
        setConversationList(finalResponse.conversations);
        setApprovals(finalResponse.pendingApprovals);
        setAttachments([]);
        router.replace(`${basePath}?conversationId=${finalResponse.conversation.id}`);
      } catch (submitError) {
        const messageText = submitError instanceof Error ? submitError.message : 'Request failed';
        setError(messageText);
        setConversation((current) =>
          current
            ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `assistant_error_${Date.now()}`,
                  role: 'assistant',
                  content: `Request failed: ${messageText}`,
                  createdAt: new Date().toISOString(),
                  metadata: { mode, surface, projectId: projectId || null, error: messageText },
                },
              ],
            }
            : current
        );
      } finally {
        setPending(false);
        setProgressUpdates([]);
      }
    };

    const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      const hasImageAttachment =
        attachments?.length > 0 && (attachments[0].mimeType?.startsWith("image") || attachments[0].mimeType === "application/pdf");

       if (pending || (!input.trim() && !hasImageAttachment))  {
        return;
      }
      void submitMessage(event);
    };

    const startNewConversation = () => {
      setConversation(null);
      setWorkspace({ artifacts: [] });
      setInput('');
      setError(null);
      setAttachments([]);
      router.replace(basePath);
    };
    const confirmDeleteConversation = async () => {

      if (!conversationToDelete) return;

      setDeletePendingId(conversationToDelete.id);

      try {

        const response = await fetch(
          `/api/assistant/conversations/${conversationToDelete.id}`,
          { method: "DELETE" }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to delete conversation");
        }

        setConversationList((current) =>
          current.filter((item) => item.id !== conversationToDelete.id)
        );

        if (conversation?.id === conversationToDelete.id) {
          setConversation(null);
          setWorkspace({ artifacts: [] });
          setInput("");
          router.replace(basePath);
        }

        setConversationToDelete(null);

      } catch (error) {

        setError(
          error instanceof Error
            ? error.message
            : "Failed to delete conversation"
        );

      } finally {

        setDeletePendingId(null);

      }

    };
    const startEditingResearchPlan = (approval: ApprovalAction) => {
      setEditingApprovalId(approval.id);
      setResearchPlanDraft(JSON.stringify(approval.payload?.research_plan || {}, null, 2));
      setApprovalResult(null);
    };

    const saveResearchPlan = async () => {
      if (!editingApprovalId) {
        return;
      }
      setApprovalPendingId(editingApprovalId);
      setApprovalResult(null);
      try {
        const response = await fetch(`/api/approvals/${editingApprovalId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: 'EDITING',
            researchPlanText: researchPlanDraft,
          }),
        });
        const data = (await response.json()) as {
          error?: string;
          result?: { message?: string };
          pendingApprovals?: ApprovalAction[];
        };
        if (!response.ok) {
          throw new Error(data.error || 'Failed to save research plan');
        }
        if (Array.isArray(data.pendingApprovals)) {
          setApprovals(data.pendingApprovals);
        }
        setEditingApprovalId(null);
        setResearchPlanDraft('');
        setApprovalResult(data.result?.message || 'Research plan updated.');
      } catch (error) {
        setApprovalResult(error instanceof Error ? error.message : 'Failed to save research plan');
      } finally {
        setApprovalPendingId(null);
      }
    };
    return (
      <div className="assistant-layout">
        <aside className="assistant-sidebar">
          <button type="button" className="primary-action wide" onClick={startNewConversation}>
            <Plus size={16} />
            <span>New Conversation</span>
          </button>

          <div className="conversation-list">
            {conversationList.map((item) => (
              <div key={item.id} className={`conversation-link ${conversation?.id === item.id ? 'active' : ''}`}>
                <Link href={`${basePath}?conversationId=${item.id}`} className="conversation-link-main">
                  <span>{item.title}</span>
                  <small>{new Date(item.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
                </Link>
                <button
                  type="button"
                  className="conversation-delete-button"
                  aria-label={`Delete conversation ${item.title}`}
                  onClick={() => setConversationToDelete(item)}
                  disabled={deletePendingId === item.id}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="assistant-stage">
          <header className="assistant-stage-header">
            <div className="assistant-stage-header-main">
              <div className="assistant-stage-badge">
                <span className="online-dot" />
                <span>{projectName ? 'Project Assistant' : 'AI Personal Assistant'}</span>
                {!projectName ? <span className="assistant-model-pill">Opus · Sonnet</span> : null}
              </div>
              <h1>{projectName ? projectName : 'Your AI Personal Assistant'}</h1>
              <p>{headerSubtitle}</p>
            </div>
          </header>

          <div className="assistant-stage-body">
            {!conversation && messages.length === 0 && mode === 'assistant' ? (
              <div className="assistant-hero">
                <div className="assistant-hero-icon">
                  <Sparkles size={28} />
                </div>
                <h2>Your AI Personal Assistant</h2>
                <p>Powered by Claude Opus &amp; Sonnet. It automatically routes work to the right model based on task complexity.</p>
                <div className="starter-grid">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button key={prompt.prompt} type="button" className="starter-card" onClick={() => setInput(prompt.prompt)}>
                      <strong>{prompt.title}</strong>
                      <span>{prompt.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-thread">
                {messages.map((message) => (
                  <article key={message.id} className={`chat-message ${message.role}`}>
                    <div className="chat-message-card">

                      <div className="chat-message-meta">
                        <span>{message.role === 'user' ? 'You' : 'Assistant'}</span>
                        <time>
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </time>
                      </div>

                      <div className="markdown-body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ node: _node, href, ...props }) => (
                              <a {...props} href={href} {...getMarkdownAnchorProps(href)} />
                            ),
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>

                    </div>
                  </article>
                ))}

                {receipt && (
                  <div className="mt-4">
                    <ReceiptReview
                      receipt={receipt}
                      onConfirm={async (data) => {
                        const endpoint = derivedProjectId
                        ? `/api/projects/${derivedProjectId}/finance`
                        : "/api/expenses";
                        const payload = {
                          kind: "expense",
                          description: data.vendor?.name || "Receipt expense",
                          amount: data.total ?? 0,
                          entryDate: data.receipt?.date ?? new Date().toISOString().slice(0, 10),
                          currency: data.currency ?? "USD",
                          category: data.category_suggestion ?? null,
                          project_id: derivedProjectId || null
                        };
                        const res = await fetch(endpoint, {
                          method: "POST",
                          headers: {
                            "content-type": "application/json",
                          },
                          body: JSON.stringify(payload),
                        });    

                        const saved = await res.json();
                        console.log("SAVED RESPONSE:", saved);
                        if (!res.ok) {
                          throw new Error(saved?.error || "Failed to save expense");
                        }
                        router.refresh();
                  
                        setAttachments([]);
                        setUploadedFile(null);

                        setConversation((current) =>
                          current
                            ? {
                              ...current,
                              updatedAt: new Date().toISOString(),
                              messages: [
                                ...current.messages,
                                {
                                  id: `assistant_expense_${Date.now()}`,
                                  role: "assistant",
                                  content: `Expense saved 
                                  Vendor: ${data.vendor?.name ?? "Unknown"}
                                  Amount: ${data.total ?? 0}
                                  Category: ${data.category_suggestion ?? ""}`,
                                  createdAt: new Date().toISOString(),
                                },
                              ],
                            }
                            : current
                        );
                        setReceipt(null);
                      }}
                    />
                  </div>
                )}

                {pending ? (
                  <article className="chat-message assistant">
                    <div className="chat-message-card progress-message-card">
                      <div className="chat-message-meta">
                        <span>Assistant</span>
                        <time>Thinking...</time>
                      </div>

                      <div className="markdown-body">
                        <p>Assistant is preparing your response...</p>
                          </div>
                      </div>
                  </article>
                ) : null}

              </div>
            )}
          </div>

          {conversationToDelete ? (
            <div className="modal-backdrop" role="presentation">
              <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title">
                <h3 id="delete-conversation-title">Delete Conversation</h3>
                <p className="modal-copy">This will permanently remove this conversation from your assistant history.</p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-link-button"
                    onClick={() => setConversationToDelete(null)}
                    disabled={deletePendingId === conversationToDelete.id}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={confirmDeleteConversation}
                    disabled={deletePendingId === conversationToDelete.id}
                  >
                    {deletePendingId === conversationToDelete.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <form className="assistant-composer" onSubmit={submitMessage}>
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <span key={attachment.name} className="attachment-pill">
                  {attachment.name}
                </span>
              ))}
            </div>
            <div className="assistant-composer-row">
              <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}>
                <Paperclip size={16} />
              </button>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  mode === 'assistant'
                    ? 'Ask anything... proposals, invoices, strategy, contracts...'
                    : 'Answer the Settings Agent...'
                }
                rows={3}
              />
              <button type="submit" className="primary-action" disabled={pending || (!input.trim() && !(attachments?.length > 0 &&
        (
          attachments[0].mimeType?.startsWith("image") ||
          attachments[0].mimeType === "application/pdf"
        )
      ))
  }
>
              <span>{pending ? 'Processing…' : 'Send'}</span>
              <ArrowUpRight size={16} />
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setUploadedFile(file);
              setAttachments([
                {
                  name: file.name,
                  mimeType: file.type,
                  size: file.size,
                  source: 'upload',
                  file: file
                },
              ]);
            }}
          />
          {error ? (
            <p className="error-text">{error}</p>
          ) : pending ? (
            <p className="composer-hint">Assistant is preparing your response...</p>
          ) : (
            <p className="composer-hint">Upload a receipt image or PDF and press Send to extract and review it before saving.</p>
          )}
        </form>
      </section>
      </div >
    );
} 