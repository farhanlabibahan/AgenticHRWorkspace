import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import type { AuthConfig, HttpClient } from '@/server/imports/http';

/**
 * The contract between provider adapters and the import engine.
 *
 * Adapters only translate: they page through a vendor's API and hand the
 * engine normalized records (below). The engine owns everything else —
 * idempotency, stage/reason mapping, attribution, storage, progress — so a
 * new provider is one file that never touches Prisma.
 *
 * Every record carries the vendor's own id as `externalId`. The engine keys
 * an ImportRef on (org, provider, kind, externalId), which makes re-running
 * an import safe: new records are added, and ones imported before are
 * updated where they changed at the vendor (see loader.ts, "Re-imports").
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Opaque, JSON-serializable pagination state an adapter keeps between steps. */
export type Cursor = JsonValue;

// ---------- Options the admin picks when starting an import ----------

export type ImportOptions = {
  /** Archived / rejected / hired applications, not just active pipeline. */
  archived: boolean;
  /** Notes, scorecards/feedback, and interviews. */
  activity: boolean;
  offers: boolean;
  /** Resume binaries (+ text extraction) and other candidate attachments. */
  files: boolean;
  /** ISO date: only candidates/applications created on or after it. */
  since: string | null;
};

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  archived: true,
  activity: true,
  offers: true,
  files: true,
  since: null,
};

// ---------- References between records ----------

/** A pipeline stage as the vendor refers to it: by id, by name, or both. */
export type StageRef = { externalId?: string | null; name?: string | null };

/** An archive/rejection reason as the vendor refers to it. */
export type ReasonRef = { externalId?: string | null; name?: string | null };

// ---------- Discovery (catalog) records ----------
// Discover phases describe the vendor's configuration without writing to the
// org. The admin reviews the resulting stage/reason mapping before any
// candidate data lands.

export type CatalogStage = {
  externalId: string;
  name: string;
  /** Adapter's best guess at our StageType when the vendor says (e.g. "offer"). */
  typeHint?: StageType | null;
  /** Position within the vendor pipeline it belongs to — orders new stages. */
  position?: number | null;
};

export type ReasonKind = 'rejection' | 'withdrawn' | 'hired' | 'other';

export type CatalogReason = {
  externalId: string;
  name: string;
  kind: ReasonKind;
};

export type CatalogUser = {
  externalId: string;
  name: string;
  email: string | null;
};

export type CatalogWriter = {
  stage(stage: CatalogStage): void;
  reason(reason: CatalogReason): void;
  user(user: CatalogUser): void;
};

// ---------- Data records ----------

export type ImportedPosting = {
  externalId: string;
  title: string;
  /** open → imported as DRAFT (never auto-published); closed → CLOSED. */
  state: 'open' | 'closed' | 'draft' | 'internal';
  department?: string | null;
  location?: string | null;
  commitment?: Commitment | null;
  workplaceType?: WorkplaceType | null;
  /** Plain text. Use htmlToText() on vendor HTML. */
  description?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  tags?: string[];
  confidential?: boolean;
  requisitionExternalId?: string | null;
  createdAt?: Date | null;
};

export type ImportedRequisition = {
  externalId: string;
  code: string;
  title: string;
  state: 'open' | 'on_hold' | 'closed';
  openings?: number | null;
  filled?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  backfill?: boolean;
};

export type ImportedCandidate = {
  externalId: string;
  name: string;
  emails: string[];
  phones: string[];
  links: string[];
  headline?: string | null;
  location?: string | null;
  tags?: string[];
  createdAt?: Date | null;
};

export type StageHistoryEntry = {
  stage: StageRef;
  at: Date;
  actorExternalUserId?: string | null;
};

export type ImportedApplication = {
  externalId: string;
  candidateExternalId: string;
  /**
   * The candidate inline, when the vendor payload has it. Lets the engine
   * create the contact on demand — e.g. a candidate from before the
   * `since` date who applied again after it.
   */
  candidate?: ImportedCandidate | null;
  postingExternalId?: string | null;
  stage: StageRef | null;
  status: 'active' | 'archived' | 'hired';
  archiveReason?: ReasonRef | null;
  archivedAt?: Date | null;
  origin?: Origin | null;
  source?: string | null;
  ownerExternalUserId?: string | null;
  confidential?: boolean;
  createdAt?: Date | null;
  /** Oldest first. The last entry should match `stage`. */
  history?: StageHistoryEntry[];
  /** Vendor custom-field values worth keeping; stored under customFields.imported.fields. */
  fields?: Record<string, string>;
};

/** Notes attach to an application; candidate-level notes land on the candidate's latest one. */
export type ImportedNote = {
  externalId: string;
  applicationExternalId?: string | null;
  candidateExternalId?: string | null;
  authorExternalUserId?: string | null;
  authorName?: string | null;
  body: string;
  createdAt?: Date | null;
};

export type ImportedFeedback = {
  externalId: string;
  applicationExternalId: string;
  interviewExternalId?: string | null;
  authorExternalUserId?: string | null;
  authorName?: string | null;
  /** 1 strong no · 2 no · 3 yes · 4 strong yes. null = no overall decision → imported as a note. */
  rating: 1 | 2 | 3 | 4 | null;
  title?: string | null;
  summary: string;
  answers?: { label: string; value: string }[];
  createdAt?: Date | null;
};

export type ImportedInterview = {
  externalId: string;
  applicationExternalId: string;
  title: string;
  startAt: Date;
  durationMins?: number | null;
  location?: string | null;
  panelistExternalUserIds?: string[];
  state?: 'scheduled' | 'completed' | 'canceled' | null;
};

export type ImportedOffer = {
  externalId: string;
  applicationExternalId: string;
  status: OfferStatus;
  jobTitle?: string | null;
  salaryAmount?: number | null;
  salaryCurrency?: string | null;
  equity?: string | null;
  startDate?: Date | null;
  sentAt?: Date | null;
  respondedAt?: Date | null;
  createdAt?: Date | null;
  notes?: string | null;
};

export type DownloadedFile = { data: Buffer; contentType?: string | null; filename?: string | null };

export type ImportedFile = {
  externalId: string;
  candidateExternalId: string;
  applicationExternalId?: string | null;
  filename: string;
  kind: 'resume' | 'other';
  /** Called only when the file hasn't been imported yet. */
  download: () => Promise<DownloadedFile>;
};

export type Loader = {
  posting(record: ImportedPosting): Promise<void>;
  requisition(record: ImportedRequisition): Promise<void>;
  candidate(record: ImportedCandidate): Promise<void>;
  application(record: ImportedApplication): Promise<void>;
  note(record: ImportedNote): Promise<void>;
  feedback(record: ImportedFeedback): Promise<void>;
  interview(record: ImportedInterview): Promise<void>;
  offer(record: ImportedOffer): Promise<void>;
  file(record: ImportedFile): Promise<void>;
  /** True when this vendor record was already imported (any run). Lets adapters skip children of records never imported. */
  has(kind: RefKind, externalId: string): Promise<boolean>;
  /**
   * True when this run already created or updated this record. Lets adapters
   * skip fetching a record's details twice in one run, while a record from an
   * earlier run is still read so a re-import can update it.
   */
  handled(kind: RefKind, externalId: string): Promise<boolean>;
};

export type RefKind =
  | 'user'
  | 'stage'
  | 'reason'
  | 'posting'
  | 'requisition'
  | 'contact'
  | 'opportunity'
  | 'note'
  | 'feedback'
  | 'interview'
  | 'offer'
  | 'file';

// ---------- Phases & adapters ----------

export type PhaseContext = {
  http: HttpClient;
  catalog: CatalogWriter;
  load: Loader;
  options: ImportOptions;
  /** Parsed options.since, for adapters that can filter server-side. */
  since: Date | null;
  /**
   * An earlier import from this provider already brought applications into
   * the org, so this run also updates them: an adapter that filters archived
   * records out server-side should still fetch them, since one imported
   * while active may have been archived since (the loader skips archived
   * records it hasn't seen when options.archived is off).
   */
  resync?: boolean;
  /** Check between records; return a cursor promptly once it is true. */
  outOfTime(): boolean;
  /** Record a non-fatal problem (shown on the job page). Never include credentials. */
  warn(message: string, detail?: { entity?: string; externalId?: string }): void;
};

export type Phase = {
  id: string;
  label: string;
  /** Skip the phase entirely for these options (e.g. offers off). */
  enabled?: (options: ImportOptions) => boolean;
  /**
   * Do one bounded unit of work (usually one page) and return the cursor to
   * resume from, or null when the phase is complete. Must be safe to re-run
   * from the same cursor: a step that dies halfway is simply replayed.
   */
  run(ctx: PhaseContext, cursor: Cursor | null): Promise<Cursor | null>;
};

export type ProviderAdapter = {
  /** Cheapest authenticated call. Returns the vendor account/company name. */
  verify(): Promise<{ accountName: string }>;
  /** Configuration only: users, stages, reasons → catalog. No writes. */
  discover: Phase[];
  /** Data, in dependency order: postings before applications, etc. */
  load: Phase[];
};

export type Credentials = Record<string, string>;

export type ProviderModule = {
  id: string;
  /**
   * A re-import updates records imported before, not only adds new ones
   * (loader.ts, "Re-imports"). Only for adapters that hand the loader a
   * complete record for those too: one that sends a shallow copy of a
   * record it has seen (to save API calls) would wipe what it leaves out.
   */
  updatesOnReimport?: boolean;
  /**
   * Build an adapter. Must be side-effect free and must not validate or
   * require credentials — the engine also calls it with `{}` just to read
   * the phase list for progress display. Validate inside verify()/phases.
   */
  create(credentials: Credentials, http: HttpClient): ProviderAdapter;
  /**
   * Which hosts get credentials, and how: static headers/query for API keys,
   * or getHeaders() for token-based auth (see AuthConfig). Requests to any
   * other host — e.g. pre-signed resume URLs — are sent without credentials.
   */
  auth(credentials: Credentials): AuthConfig;
  /** Minimum spacing between API requests, from the vendor's published limit. */
  minIntervalMs: number;
  /** Per-request timeout when the vendor documents slow endpoints (default 30 s). */
  timeoutMs?: number;
};
