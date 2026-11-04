# ClientFlow

ClientFlow is an AI-assisted workspace for small consulting and service firms. It keeps clients, projects, tasks, documents, invoices, expenses and email in one place, and an AI assistant works across all of them using your firm's profile and real workspace data.

## Features

- **Dashboard:** today's meetings, synced inbox summaries, upcoming tasks and quick actions (proposal, invoice, contract review, new project, financial analysis, strategy advice).
- **AI Assistant:** streaming chat that drafts proposals, email replies, project updates and invoices, and can create or summarize records in the workspace. Risky actions go through an approval step first.
- **Clients and projects:** client records linked to projects, with per-project tabs for tasks, documents, finance and timezone.
- **Finance:** invoices with line items and PDF export, expenses, and a per-project financial summary.
- **Receipts:** upload a receipt image or PDF, extract the data, review it, then save.
- **Documents:** project documents and generated files (proposals, Excel and Word exports).
- **Email Hub:** connect a mailbox through Nylas, get summaries, draft replies, and create meetings from threads.
- **Calendar:** Google Calendar sync, day view, meeting prep and notes.
- **Automations and LinkedIn:** scheduled automations and a LinkedIn workspace.

## Tech stack

- **Framework:** Next.js 14 (App Router), React 18, TypeScript
- **Database:** PostgreSQL, queried with `pg` (raw SQL, no ORM)
- **Auth:** NextAuth.js (Google sign-in)
- **AI:** OpenAI (configurable through `AI_PROVIDER`)
- **Files:** pdf-lib, pdf-parse, docx, exceljs, pptxgenjs, mammoth, jszip
- **Styling:** Tailwind CSS 4
- **Deployment:** Dockerfile included (multi-stage, Node 20 Alpine)

## Project structure

```
app/          Next.js routes: pages (workspace) and API routes (app/api)
components/   React UI (project tabs, finance, assistant console, tasks, calendar...)
lib/          Server logic: db access, AI orchestration, assistant actions,
              invoices, proposals, email hub, calendar, Google and Nylas integrations
db/proposed/  SQL migrations to apply to the database
scripts/      Helper scripts (e.g. render_proposal_pdf.py)
types/        Shared TypeScript types
```

## Getting started

### Prerequisites

- Node.js 20 or newer
- PostgreSQL 14 or newer
- Python 3 (only for the proposal PDF script)
- A Google OAuth client (for sign-in and calendar), and an OpenAI API key

### 1. Install dependencies

```bash
npm ci
```

### 2. Configure environment variables

Create a `.env.local` file in the project root. Never commit it.

```bash
DATABASE_URL=postgres://user:password@localhost:5432/clientflow
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=generate-a-long-random-string
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
OPENAI_API_KEY=your-openai-key
AI_PROVIDER=openai
```

### 3. Set up the database

Apply the schema migration to your database:

```bash
psql "$DATABASE_URL" -f db/proposed/0001_align_schema_with_app.sql
```

### 4. Run the app

```bash
npm run dev
```

Open http://localhost:3000.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run lint` | Run ESLint |

## Docker

```bash
docker build -t clientflow .
docker run --env-file .env.local -p 3000:3000 clientflow
```

## Security notes

- Keep `.env.local` and all API keys out of Git. The `.gitignore` already excludes `.env*`.
- Every API route checks the current user and scopes queries to that user's data.
- Rotate `NEXTAUTH_SECRET` and any key that was ever committed or shared.

## Status

Active development. Some features are still being finished; see the issues or project notes for what is in progress.
