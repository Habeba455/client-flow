'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, StatusPill } from '@/components/workspace-ui';
import type { ConnectedAccounts } from '@/lib/product-data';
import type { GmailThreadSummary } from '@/lib/google/gmail';

interface EmailAnalysisPayload {
  thread: {
    id: string;
    subject: string;
    messages: Array<{
      id: string;
      from: string;
      to: string;
      cc: string;
      body: string;
      receivedAt: string | null;
      attachments: Array<{ filename: string }>;
    }>;
  };
  project: { id: string; name: string; description: string | null } | null;
  analysis: {
    summary: string;
    todos: Array<{ task: string; priority: string; source_quote: string }>;
    meeting_requested: boolean;
    meeting_details: {
      requested_by: string;
      purpose: string;
      duration_requested: string;
      urgency: string;
      proposed_times: string[];
    } | null;
    sentiment: string;
    sender: { name: string; email: string; company: string | null };
    reply_needed: boolean;
    reply_urgency: string;
    attachments_detected: Array<{ filename: string; type: string; relevance: string }>;
  };
  meetingInviteSent?: boolean;
  meetingCalendarEventId?: string | null;
  suggestedSlots: Array<{ start: string; end: string; userDisplayTime: string; clientDisplayTime: string; timezoneNote?: string | null }>;
  availability?: { noOverlap: boolean; message: string | null; nearestOption: string | null; skippedReasons?: string[] };
  persistedTodos: number;
  ingestedAttachments: number;
}

interface EmailDraftPayload {
  to: string;
  to_name: string;
  subject: string;
  body: string;
  suggested_send_time: string | null;
  tone_used: string;
  approval?: { id: string; status: string } | null;
}

interface MeetingCreatePayload {
  id: string;
  threadId?: string;
  attendeeEmail: string;
  attendeeName: string | null;
  error?: string;
}

interface InboxPagePayload {
  items: GmailThreadSummary[];
  nextCursor: string | null;
  error?: string;
}

function sanitizeRenderedEmailText(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2580-\u259F\u25A0-\u25FF]+/g, ' ')
    .replace(/[│┆┇┊┋╎╏]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function EmailHubWorkspace({
  accounts,
  initialInbox,
  initialNextCursor,
  initialSelectedThreadId,
}: {
  accounts: ConnectedAccounts;
  initialInbox: GmailThreadSummary[];
  initialNextCursor?: string | null;
  initialSelectedThreadId?: string | null;
}) {
  type InboxFilter = 'all' | 'unread' | 'read' | 'with_todos' | 'meeting_requests';
  const initialPageKey = '__page_1__';
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageOrder, setPageOrder] = useState<string[]>([initialPageKey]);
  const [pageCache, setPageCache] = useState<Record<string, { items: GmailThreadSummary[]; nextCursor: string | null }>>({
    [initialPageKey]: {
      items: initialInbox,
      nextCursor: initialNextCursor || null,
    },
  });
  const [loadingPage, setLoadingPage] = useState(false);
  const [specialPageIndex, setSpecialPageIndex] = useState(0);
  const [specialPageOrder, setSpecialPageOrder] = useState<string[]>([]);
  const [specialPageCache, setSpecialPageCache] = useState<Record<string, { items: GmailThreadSummary[]; nextCursor: string | null }>>({});
  const [loadingSpecialPage, setLoadingSpecialPage] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState(initialSelectedThreadId || initialInbox[0]?.threadId || null);
  const [analysis, setAnalysis] = useState<EmailAnalysisPayload | null>(null);
  const [analysisCache, setAnalysisCache] = useState<Record<string, EmailAnalysisPayload>>({});
  const [draft, setDraft] = useState<EmailDraftPayload | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isCreatingMeeting, setIsCreatingMeeting] = useState(false);
  const [selectedSlotStart, setSelectedSlotStart] = useState<string | null>(null);
  const [meetingSentByThread, setMeetingSentByThread] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [threadMeta, setThreadMeta] = useState<Record<string, { hasTodos: boolean; meetingRequested: boolean }>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [highlightDraft, setHighlightDraft] = useState(false);
  const draftSectionRef = useRef<HTMLDivElement | null>(null);
  const inboxListRef = useRef<HTMLDivElement | null>(null);
  const threadStageRef = useRef<HTMLDivElement | null>(null);
  const analysisStackRef = useRef<HTMLDivElement | null>(null);
  const previousRemoteScopeRef = useRef<string | null>(null);

  const currentPageKey = pageOrder[pageIndex] || initialPageKey;
  const currentPage = pageCache[currentPageKey] || { items: initialInbox, nextCursor: initialNextCursor || null };
  const normalizedSearchQuery = searchQuery.trim();
  const specialFilter = normalizedSearchQuery ? null : inboxFilter === 'with_todos' || inboxFilter === 'meeting_requests' ? inboxFilter : null;
  const remoteScopeKey = debouncedSearchQuery
    ? `search:${debouncedSearchQuery.toLowerCase()}`
    : specialFilter;
  const specialCurrentPageKey = specialPageOrder[specialPageIndex] || null;
  const specialCurrentPage = specialCurrentPageKey ? specialPageCache[specialCurrentPageKey] || { items: [], nextCursor: null } : { items: [], nextCursor: null };
  const knownInbox = useMemo(() => {
    const seen = new Set<string>();
    return pageOrder.flatMap((key) =>
      (pageCache[key]?.items || []).filter((item) => {
        if (seen.has(item.threadId)) {
          return false;
        }
        seen.add(item.threadId);
        return true;
      })
    );
  }, [pageCache, pageOrder]);
  const fallbackSpecialInbox = useMemo(
    () =>
      knownInbox.filter((email) =>
        remoteScopeKey?.startsWith('search:')
          ? [email.from, email.to, email.subject, email.snippet, email.body].some((value) => value.toLowerCase().includes(debouncedSearchQuery.toLowerCase()))
          : specialFilter === 'with_todos'
          ? email.hasTodos === true || threadMeta[email.threadId]?.hasTodos === true
          : specialFilter === 'meeting_requests'
            ? email.meetingRequested === true || threadMeta[email.threadId]?.meetingRequested === true
            : false
      ),
    [debouncedSearchQuery, knownInbox, remoteScopeKey, specialFilter, threadMeta]
  );
  const inbox = remoteScopeKey ? (specialCurrentPage.items.length > 0 ? specialCurrentPage.items : fallbackSpecialInbox) : currentPage.items;
  const nextCursor = remoteScopeKey ? specialCurrentPage.nextCursor : currentPage.nextCursor;
  const isLoadingInbox = remoteScopeKey ? loadingSpecialPage : loadingPage;
  const hasAnyInbox = initialInbox.length > 0 || Object.values(pageCache).some((page) => page.items.length > 0);

  const scrollPanelsToTop = (behavior: ScrollBehavior = 'auto') => {
    inboxListRef.current?.scrollTo({ top: 0, behavior });
    threadStageRef.current?.scrollTo({ top: 0, behavior });
    analysisStackRef.current?.scrollTo({ top: 0, behavior });
    window.scrollTo({ top: 0, behavior });
  };

  const resetPageView = (nextThreadId: string | null) => {
    setSelectedThreadId(nextThreadId);
    setAnalysis(null);
    setDraft(null);
    setSelectedSlotStart(null);
    setMessage(null);
  };

  useEffect(() => {
    if (!selectedThreadId && inbox[0]?.threadId) {
      setSelectedThreadId(inbox[0].threadId);
    }
  }, [inbox, selectedThreadId]);

  useEffect(() => {
    if (selectedThreadId && inbox.some((item) => item.threadId === selectedThreadId)) {
      return;
    }
    setSelectedThreadId(inbox[0]?.threadId || null);
  }, [inbox, selectedThreadId]);

  useEffect(() => {
    if (previousRemoteScopeRef.current !== remoteScopeKey) {
      previousRemoteScopeRef.current = remoteScopeKey;
      setSpecialPageIndex(0);
      setSpecialPageOrder([]);
      setSpecialPageCache({});
    }
  }, [remoteScopeKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(normalizedSearchQuery);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [normalizedSearchQuery]);

  useEffect(() => {
    if (!remoteScopeKey || specialPageOrder.length > 0 || loadingSpecialPage) {
      return;
    }

    let cancelled = false;
    const loadSpecialInbox = async () => {
      setLoadingSpecialPage(true);
      try {
        const params = new URLSearchParams({ offset: '0', limit: '20' });
        if (debouncedSearchQuery) {
          params.set('q', debouncedSearchQuery);
        } else if (specialFilter) {
          params.set('filter', specialFilter);
        }
        const response = await fetch(`/api/email-hub/inbox?${params.toString()}`);
        const data = (await response.json()) as InboxPagePayload;
        if (!response.ok) {
          throw new Error(data.error || 'Failed to load inbox');
        }
        if (!cancelled) {
          const firstPageKey = `${remoteScopeKey}__page_1`;
          setSpecialPageCache({
            [firstPageKey]: {
              items: data.items,
              nextCursor: data.nextCursor || null,
            },
          });
          setSpecialPageOrder([firstPageKey]);
          setSpecialPageIndex(0);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Failed to load inbox');
        }
      } finally {
        if (!cancelled) {
          setLoadingSpecialPage(false);
        }
      }
    };

    void loadSpecialInbox();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery, loadingSpecialPage, remoteScopeKey, specialFilter, specialPageOrder.length]);

  const filteredInbox = useMemo(() => {
    let list = inbox.filter((email) => {
      if (inboxFilter === 'all') return true;
      if (inboxFilter === 'unread') return email.unread === true;
      if (inboxFilter === 'read') return email.unread === false;
      if (inboxFilter === 'with_todos') return email.hasTodos === true || threadMeta[email.threadId]?.hasTodos === true;
      if (inboxFilter === 'meeting_requests') return email.meetingRequested === true || threadMeta[email.threadId]?.meetingRequested === true;
      return true;
    });
    const q = normalizedSearchQuery.toLowerCase();
    if (q) {
      list = list.filter(
        (email) =>
          email.from.toLowerCase().includes(q) ||
          email.to.toLowerCase().includes(q) ||
          email.subject.toLowerCase().includes(q) ||
          email.snippet.toLowerCase().includes(q) ||
          email.body.toLowerCase().includes(q)
      );
    }
    return list;
  }, [inbox, inboxFilter, normalizedSearchQuery, threadMeta]);

  const selected = useMemo(
    () => filteredInbox.find((item) => item.threadId === selectedThreadId) || filteredInbox[0] || null,
    [filteredInbox, selectedThreadId]
  );

  useEffect(() => {
    if (filteredInbox.length === 0) {
      setSelectedThreadId(null);
      return;
    }
    if (selectedThreadId && filteredInbox.some((item) => item.threadId === selectedThreadId)) {
      return;
    }
    setSelectedThreadId(filteredInbox[0].threadId);
  }, [filteredInbox, selectedThreadId]);

  const formatWhen = (value: string | null) => {
    if (!value) return 'Unknown time';
    return new Date(value).toLocaleString();
  };

  const goToNextPage = async () => {
    if (!nextCursor || isLoadingInbox) return;
    if (remoteScopeKey) {
      const existingNextPageKey = specialPageOrder[specialPageIndex + 1];
      if (existingNextPageKey && specialPageCache[existingNextPageKey]) {
        const existingNextPage = specialPageCache[existingNextPageKey];
        setSpecialPageIndex((prev) => prev + 1);
        resetPageView(existingNextPage?.items[0]?.threadId || null);
        return;
      }

      setLoadingSpecialPage(true);
      resetPageView(null);
      try {
        const params = new URLSearchParams({ offset: String(nextCursor), limit: '20' });
        if (debouncedSearchQuery) {
          params.set('q', debouncedSearchQuery);
        } else if (specialFilter) {
          params.set('filter', specialFilter);
        }
        const response = await fetch(`/api/email-hub/inbox?${params.toString()}`);
        const data = (await response.json()) as InboxPagePayload;
        if (!response.ok) {
          throw new Error(data.error || 'Failed to load inbox page');
        }
        const nextPageKey = `${remoteScopeKey}__page_${specialPageIndex + 2}`;
        setSpecialPageCache((prev) => ({
          ...prev,
          [nextPageKey]: {
            items: data.items,
            nextCursor: data.nextCursor || null,
          },
        }));
        setSpecialPageOrder((prev) => [...prev, nextPageKey]);
        setSpecialPageIndex((prev) => prev + 1);
        resetPageView(data.items[0]?.threadId || null);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Failed to load inbox page');
      } finally {
        setLoadingSpecialPage(false);
      }
      return;
    }

    const existingNextPageKey = pageOrder[pageIndex + 1];
    if (existingNextPageKey && pageCache[existingNextPageKey]) {
      const existingNextPage = pageCache[existingNextPageKey];
      setPageIndex((prev) => prev + 1);
      resetPageView(existingNextPage?.items[0]?.threadId || null);
      return;
    }

    setLoadingPage(true);
    resetPageView(null);
    try {
      const response = await fetch(`/api/email-hub/inbox?cursor=${encodeURIComponent(nextCursor)}&limit=20`);
      const data = (await response.json()) as InboxPagePayload;
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load more emails');
      }
      const nextPageKey = `page_${pageIndex + 2}_${nextCursor}`;
      setPageCache((prev) => ({
        ...prev,
        [nextPageKey]: {
          items: data.items,
          nextCursor: data.nextCursor || null,
        },
      }));
      setPageOrder((prev) => [...prev, nextPageKey]);
      setPageIndex((prev) => prev + 1);
      resetPageView(data.items[0]?.threadId || null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load inbox page');
    } finally {
      setLoadingPage(false);
    }
  };

  const goToPreviousPage = () => {
    if (remoteScopeKey) {
      if (specialPageIndex === 0 || loadingSpecialPage) return;
      const previousPageKey = specialPageOrder[specialPageIndex - 1];
      const previousPage = specialPageCache[previousPageKey];
      setSpecialPageIndex((prev) => prev - 1);
      resetPageView(previousPage?.items[0]?.threadId || null);
      return;
    }
    if (pageIndex === 0 || loadingPage) return;
    const previousPageKey = pageOrder[pageIndex - 1];
    const previousPage = pageCache[previousPageKey];
    setPageIndex((prev) => prev - 1);
    resetPageView(previousPage?.items[0]?.threadId || null);
  };

  const updateThreadStatus = async (threadId: string, unread: boolean) => {
    setIsUpdatingStatus(true);
    setMessage(null);
    try {
      const response = await fetch('/api/email-hub/thread-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, unread }),
      });
      const data = (await response.json()) as { threadId?: string; unread?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update thread status');
      }
      setPageCache((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.entries(prev).map(([key, page]) => [
            key,
            {
              ...page,
              items: (page.items || []).map((item) => (item.threadId === threadId ? { ...item, unread } : item)),
            },
          ])
        ),
      }));
      setSpecialPageCache((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.entries(prev).map(([key, page]) => [
            key,
            {
              ...page,
              items: (page.items || []).map((item) => (item.threadId === threadId ? { ...item, unread } : item)),
            },
          ])
        ),
      }));
      setMessage(unread ? 'Thread marked as unread.' : 'Thread marked as read.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update thread status');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const fetchAnalysis = async (threadId: string, options?: { keepDraft?: boolean; silent?: boolean }) => {
    const cachedAnalysis = analysisCache[threadId];
    if (cachedAnalysis) {
      setAnalysis(cachedAnalysis);
      return cachedAnalysis;
    }
    setIsAnalyzing(true);
    if (!options?.keepDraft) {
      setDraft(null);
    }
    if (!options?.silent) {
      setMessage(null);
    }
    try {
      const currentThread = inbox.find((item) => item.threadId === threadId) || null;
      const response = await fetch('/api/email-hub/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, lastMessageAt: currentThread?.receivedAt || null }),
      });
      const data = (await response.json()) as EmailAnalysisPayload & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to analyze email');
      }
      setAnalysis(data);
      setSelectedSlotStart((prev) => (data.suggestedSlots.some((slot) => slot.start === prev) ? prev : data.suggestedSlots[0]?.start || null));
      setAnalysisCache((prev) => ({
        ...prev,
        [threadId]: data,
      }));
      setThreadMeta((prev) => ({
        ...prev,
        [threadId]: {
          hasTodos: data.persistedTodos > 0,
          meetingRequested: data.analysis.meeting_requested === true,
        },
      }));
      if (!options?.silent) {
        setMessage(
          data.persistedTodos > 0 || data.ingestedAttachments > 0
            ? `Summary ready. ${data.persistedTodos} task${data.persistedTodos === 1 ? '' : 's'} saved; ${data.ingestedAttachments} attachment${data.ingestedAttachments === 1 ? '' : 's'} ingested.`
            : 'Summary ready.'
        );
      }
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to analyze email');
      return null;
    } finally {
      setIsAnalyzing(false);
    }
  };

  const runAnalysis = async (threadId: string) => fetchAnalysis(threadId);

  useEffect(() => {
    if (!selected?.threadId) return;
    if (analysisCache[selected.threadId]) {
      setAnalysis(analysisCache[selected.threadId]);
      setSelectedSlotStart(null);
      return;
    }
    if (analysis?.thread.id === selected.threadId) return;
    setSelectedSlotStart(null);
    void fetchAnalysis(selected.threadId, { silent: true, keepDraft: true });
  }, [selected?.threadId, analysisCache]);

  useEffect(() => {
    if (!selected?.threadId || selected.unread !== true) return;
    void updateThreadStatus(selected.threadId, false);
  }, [selected?.threadId, selected?.unread]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => {
      setMessage(null);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (!draft) {
      return;
    }
    draftSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightDraft(true);
    const timeout = window.setTimeout(() => {
      setHighlightDraft(false);
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [draft]);

  useEffect(() => {
    scrollPanelsToTop();
  }, [currentPageKey, specialCurrentPageKey]);

  const draftReply = async (threadId: string) => {
    setIsDrafting(true);
    setMessage(null);
    try {
      if (analysis?.thread.id !== threadId) {
        const analysisResult = await fetchAnalysis(threadId, { silent: true, keepDraft: true });
        if (!analysisResult) {
          return;
        }
      }
      const response = await fetch('/api/email-hub/draft-reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, lastMessageAt: selected?.receivedAt || null }),
      });
      const data = (await response.json()) as EmailDraftPayload & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to draft reply');
      }
      setDraft(data);
      setMessage(data.approval ? 'Your draft reply is ready for review below.' : 'Your draft reply is ready below.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to draft reply');
    } finally {
      setIsDrafting(false);
    }
  };

  const selectedAnalysis = analysis?.thread.id === selected?.threadId ? analysis : null;
  const messageCount = selectedAnalysis?.thread.messages.length || (selected ? 1 : 0);
  const latestMessage = selectedAnalysis?.thread.messages[selectedAnalysis.thread.messages.length - 1] || null;
  const selectedSlot = selectedAnalysis?.suggestedSlots.find((slot) => slot.start === selectedSlotStart) || selectedAnalysis?.suggestedSlots[0] || null;
  const meetingInviteAlreadySent =
    (selectedAnalysis?.meetingInviteSent === true) ||
    (selectedAnalysis ? meetingSentByThread[selectedAnalysis.thread.id] === true : false);
  const summaryTone =
    selectedAnalysis?.analysis.sentiment === 'urgent'
      ? 'danger'
      : selectedAnalysis?.analysis.sentiment === 'needs_attention'
        ? 'warning'
        : 'neutral';
  const replyTone = selectedAnalysis?.analysis.reply_needed ? 'warning' : 'neutral';

  const createMeeting = async () => {
    if (!selectedAnalysis || !selectedSlot) return;
    setIsCreatingMeeting(true);
    setMessage(null);
    try {
      const response = await fetch('/api/email-hub/create-meeting', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: selectedAnalysis.thread.id,
          start: selectedSlot.start,
          end: selectedSlot.end,
          attendeeEmail: selectedAnalysis.analysis.sender.email,
          attendeeName: selectedAnalysis.analysis.sender.name || null,
          title: selectedAnalysis.analysis.meeting_details?.purpose || selectedAnalysis.thread.subject || 'Meeting',
          description: `Scheduled from Email Hub with ${selectedAnalysis.analysis.sender.name || selectedAnalysis.analysis.sender.email}.`,
        }),
      });
      const data = (await response.json()) as MeetingCreatePayload;
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create meeting');
      }
      setMeetingSentByThread((prev) => ({
        ...prev,
        [selectedAnalysis.thread.id]: true,
      }));
      setAnalysis((prev) =>
        prev && prev.thread.id === selectedAnalysis.thread.id
          ? { ...prev, meetingInviteSent: true, meetingCalendarEventId: data.id }
          : prev
      );
      setAnalysisCache((prev) => ({
        ...prev,
        [selectedAnalysis.thread.id]: prev[selectedAnalysis.thread.id]
          ? { ...prev[selectedAnalysis.thread.id], meetingInviteSent: true, meetingCalendarEventId: data.id }
          : { ...selectedAnalysis, meetingInviteSent: true, meetingCalendarEventId: data.id },
      }));
      setMessage(`Calendar invitation sent to ${data.attendeeName || data.attendeeEmail}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create meeting');
    } finally {
      setIsCreatingMeeting(false);
    }
  };
  return (
    <div className="page-stack email-page-shell">
      <div className="email-hub-topbar email-hub-topbar-shell">
        <div className="email-hub-topbar-left">
          <span className="email-hub-kicker email-hub-kicker-inline">Email Hub</span>
          <div className="email-status-dot-row">
            <span className="email-status-dot-item">
              <span className="email-status-dot" />
              {accounts.emailConnected ? 'Gmail Connected' : 'Email Not Connected'}
            </span>
            <span className="email-status-dot-item">
              <span className="email-status-dot" />
              {accounts.calendarConnected ? 'Calendar Connected' : 'Calendar Not Connected'}
            </span>
            <span className="email-sync-note">Last synced: less than a minute ago</span>
          </div>
        </div>
        <div className="email-topbar-actions">
          <button type="button" className="icon-action-button" onClick={() => void goToNextPage()} disabled={isLoadingInbox || !nextCursor}>
            ↻
          </button>
          <button type="button" className="icon-action-button" aria-label="Settings">
            ⚙
          </button>
        </div>
      </div>

      {!hasAnyInbox ? (
        <section className="panel-card">
          <EmptyState
            title="No inbox messages available"
            description={accounts.connectAvailable ? 'Connect a Google or Microsoft mailbox through Nylas in Settings, then return here.' : 'Configure Nylas credentials to enable live inbox reads.'}
          />
        </section>
      ) : (
        <div className="email-hub-v2-grid">
          <section className="panel-card email-hub-sidebar">
            <div className="email-sidebar-header">
              <div>
                <p className="email-sidebar-label">Inbox</p>
              </div>
              <button type="button" className="icon-action-button" onClick={() => void goToNextPage()} disabled={!nextCursor || isLoadingInbox}>
                {isLoadingInbox ? '...' : '↻'}
              </button>
            </div>

            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className="email-search-input"
              aria-label="Search inbox"
            />

            <div className="email-filter-row email-filter-row-spaced">
                  {(
                    [
                      { value: 'all' as const, label: 'All' },
                      { value: 'unread' as const, label: 'Unread' },
                      { value: 'read' as const, label: 'Read' },
                      { value: 'with_todos' as const, label: 'With To-Dos' },
                      { value: 'meeting_requests' as const, label: 'Meeting Requests' },
                    ] as const
                  ).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`status-pill filter-chip ${inboxFilter === value ? 'filter-chip-active' : ''}`}
                  onClick={() => setInboxFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div ref={inboxListRef} className="email-list email-list-tall">
              {loadingSpecialPage && remoteScopeKey && inbox.length === 0 && filteredInbox.length === 0 ? (
                <p className="email-list-empty">Loading emails...</p>
              ) : filteredInbox.length === 0 ? (
                <p className="email-list-empty">No threads match this filter.</p>
              ) : (
                filteredInbox.map((email) => (
                  <button
                    key={email.threadId}
                    type="button"
                    className={`email-list-item email-list-item-dense ${selected?.threadId === email.threadId ? 'active' : ''} ${email.unread ? 'is-unread' : ''}`}
                    onClick={() => {
                      setSelectedThreadId(email.threadId);
                      setAnalysis(analysisCache[email.threadId] || null);
                      setDraft(null);
                      setMessage(null);
                    }}
                  >
                    <div className="email-list-row">
                      <strong>{email.from.split(' <')[0]}</strong>
                      <span>{email.receivedAt ? new Date(email.receivedAt).toLocaleDateString() : ''}</span>
                    </div>
                    <div className="email-list-subject-row email-list-subject-row-tight">
                      <span>{email.subject}</span>
                      {email.unread ? <span className="email-unread-dot" aria-hidden="true" /> : null}
                    </div>
                    <small>{sanitizeRenderedEmailText(email.snippet) || 'No preview available'}</small>
                  </button>
                ))
              )}
            </div>

            <div className="email-pagination-row email-pagination-controls">
              <button
                type="button"
                className="ghost-link-button"
                onClick={goToPreviousPage}
                disabled={(remoteScopeKey ? specialPageIndex === 0 : pageIndex === 0) || isLoadingInbox}
              >
                Previous
              </button>
              <span className="email-pagination-label">Page {(remoteScopeKey ? specialPageIndex : pageIndex) + 1}</span>
              <button type="button" className="ghost-link-button" onClick={() => void goToNextPage()} disabled={!nextCursor || isLoadingInbox}>
                {isLoadingInbox ? 'Loading...' : 'Next'}
              </button>
            </div>
          </section>

          <section className="panel-card email-hub-thread-panel">
            {selected ? (
              <>
                <div className="email-thread-toolbar">
                  <div className="email-thread-toolbar-copy">
                    <h2>{selectedAnalysis?.analysis.meeting_requested ? 'meeting' : selected.subject}</h2>
                    <p>{isAnalyzing ? 'Summarizing thread...' : `${messageCount} message${messageCount === 1 ? '' : 's'}`}</p>
                  </div>
                  <div className="inline-button-row email-thread-actions">
                    <button
                      type="button"
                      className="ghost-link-button email-draft-button"
                      onClick={() => void draftReply(selected.threadId)}
                      disabled={isDrafting || isAnalyzing}
                    >
                      {isDrafting ? 'Drafting...' : 'AI Draft Reply'}
                    </button>
                  </div>
                </div>

                <div ref={threadStageRef} className="email-thread-stage">
                  <article className="email-message-card email-message-card-focused">
                    <div className="email-message-meta">
                      <div>
                        <strong>{(latestMessage?.from || selected.from).split(' <')[0]}</strong>
                        <p>From: {latestMessage?.from || selected.from}</p>
                      </div>
                      <span>{formatWhen(latestMessage?.receivedAt || selected.receivedAt)}</span>
                    </div>
                    <div className="email-thread-body">
                      <p>{sanitizeRenderedEmailText(latestMessage?.body || selected.body || selected.snippet) || 'No body content available.'}</p>
                    </div>
                  </article>
                </div>
              </>
            ) : (
              <EmptyState title="Select a thread" description="Choose an email to review its content and actions." />
            )}
          </section>

          <section className="panel-card email-hub-analysis-panel">
            <div className="email-analysis-header">
              <h2>AI Analysis</h2>
              <button type="button" className="icon-action-button" onClick={() => selected && void runAnalysis(selected.threadId)} disabled={!selected || isAnalyzing}>
                ↻
              </button>
            </div>

            {selectedAnalysis ? (
              <div ref={analysisStackRef} className="analysis-stack">
                <div className="inline-status-row email-analysis-pills">
                  <StatusPill tone={summaryTone}>
                    {selectedAnalysis.analysis.sentiment}
                  </StatusPill>
                  <StatusPill tone={replyTone}>
                    {selectedAnalysis.analysis.reply_needed ? `Reply needed · ${selectedAnalysis.analysis.reply_urgency}` : 'No reply needed'}
                  </StatusPill>
                </div>

                <div className="analysis-box email-summary-card">
                  <p>{selectedAnalysis.analysis.summary}</p>
                </div>

                <div className="analysis-box email-todos-card">
                  <h3>To-Dos ({selectedAnalysis.analysis.todos.length})</h3>
                  {selectedAnalysis.analysis.todos.length > 0 ? (
                    <div className="list-stack">
                      {selectedAnalysis.analysis.todos.map((todo, index) => (
                        <div key={`${todo.task}-${index}`} className="list-row compact email-todo-row">
                          <div>
                            <strong>{todo.task}</strong>
                            <p>{todo.source_quote}</p>
                          </div>
                          <StatusPill tone={todo.priority === 'HIGH' ? 'danger' : todo.priority === 'MEDIUM' ? 'warning' : 'neutral'}>
                            {todo.priority}
                          </StatusPill>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No action items were identified.</p>
                  )}
                </div>

                {selectedAnalysis.analysis.meeting_requested ? (
                  <div className="analysis-box email-meeting-card">
                    <h3>Meeting Request Detected</h3>
                    {meetingInviteAlreadySent ? <p className="email-meeting-sent-note">Meeting invitation has been sent.</p> : null}
                    <div className="email-analysis-detail-grid">
                      <p><span>From:</span> {selectedAnalysis.analysis.meeting_details?.requested_by || selectedAnalysis.analysis.sender.name || 'Unknown'}</p>
                      <p><span>Purpose:</span> {selectedAnalysis.analysis.meeting_details?.purpose || 'not specified'}</p>
                      <p><span>Duration:</span> {selectedAnalysis.analysis.meeting_details?.duration_requested || 'not specified'}</p>
                      <p><span>Urgency:</span> {selectedAnalysis.analysis.meeting_details?.urgency || 'not specified'}</p>
                    </div>
                    {selectedAnalysis.suggestedSlots.length > 0 ? (
                      <div className="email-calendar-slot-list">
                        {selectedAnalysis.suggestedSlots.map((slot, index) => (
                          <button
                            key={`${slot.userDisplayTime}-${index}`}
                            type="button"
                            className={`email-calendar-slot ${selectedSlot?.start === slot.start ? 'is-selected' : ''}`}
                            onClick={() => setSelectedSlotStart(slot.start)}
                          >
                            <strong>{slot.userDisplayTime}</strong>
                            <p>{slot.clientDisplayTime === slot.userDisplayTime ? 'Your local time' : `Client: ${slot.clientDisplayTime}`}</p>
                            {slot.timezoneNote ? <small>{slot.timezoneNote}</small> : null}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="email-calendar-fallback">
                        {selectedAnalysis.availability?.message || 'No valid mutual slots found.'}
                        {selectedAnalysis.availability?.nearestOption ? ` Nearest option: ${selectedAnalysis.availability.nearestOption}.` : ''}
                      </p>
                    )}
                    {selectedAnalysis.availability?.skippedReasons && selectedAnalysis.availability.skippedReasons.length > 0 ? (
                      <div className="email-skip-reasons">
                        {selectedAnalysis.availability.skippedReasons.slice(0, 2).map((reason) => (
                          <p key={reason}>{reason}</p>
                        ))}
                      </div>
                    ) : null}
                    <div className="email-meeting-actions">
                      <button
                        type="button"
                        className="primary-action email-full-width-button"
                        onClick={createMeeting}
                        disabled={!selectedSlot || isCreatingMeeting || meetingInviteAlreadySent}
                      >
                        {meetingInviteAlreadySent ? 'Invitation Sent' : isCreatingMeeting ? 'Creating Event...' : 'Create Calendar Event'}
                      </button>
                      <button type="button" className="ghost-link-button email-full-width-button" onClick={() => void draftReply(selectedAnalysis.thread.id)} disabled={isDrafting}>
                        {isDrafting ? 'Drafting...' : 'Draft Reply'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {draft ? (
                  <div
                    ref={draftSectionRef}
                    className={`analysis-box email-inline-draft ${highlightDraft ? 'email-inline-draft-highlight' : ''}`}
                  >
                    <h3>Draft Reply</h3>
                    <p><strong>{draft.subject}</strong></p>
                    <div className="email-draft-output">
                      <p>{draft.body}</p>
                    </div>
                    {draft.suggested_send_time ? <p className="email-draft-meta">Suggested send time: {draft.suggested_send_time}</p> : null}
                  </div>
                ) : null}

                {selectedAnalysis.project ? (
                  <div className="analysis-box email-client-card">
                    <h3>Client</h3>
                    <div className="email-analysis-detail-grid">
                      <p><span>Name:</span> {selectedAnalysis.analysis.sender.name || 'Unknown'}</p>
                      <p><span>Email:</span> {selectedAnalysis.analysis.sender.email || 'Unknown'}</p>
                      <p><span>Project:</span> {selectedAnalysis.project.name}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : isAnalyzing ? (
              <div className="email-analysis-loading">
                <div className="email-spinner" aria-hidden="true" />
                <h3>Summarizing thread</h3>
                <p>Reading the conversation, extracting action items, and checking for meeting requests.</p>
              </div>
            ) : (
              <EmptyState title="Summarize a thread" description="Select a thread to see a summary, action items, meeting requests, and suggested replies." />
            )}
          </section>
        </div>
      )}

      {message ? <div className="email-toast">{message}</div> : null}
    </div>
  );
}
