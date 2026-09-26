import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { aiConfigured, AiUnavailableError, runAiTask, type EvaluationResult } from '@/server/ai-client';
import {
  cleanCriteria,
  computeMatchScore,
  MAX_CRITERIA,
  snapScore,
  type CriterionResult,
  type MatchCriterion,
} from '@/lib/match-criteria';
import { storeDraftedCriteria } from '@/server/match-criteria';
import { EMPTY_FACTS, readInsights, type TranscriptInsights } from '@/lib/interview-insights';
import { readHighlights } from '@/lib/highlights';

export { aiConfigured, type EvaluationResult };

/**
 * AI candidate evaluations — an advisory read of everything already on the
 * profile (resume text, application note, scorecards, stage history), never
 * a decision — plus role criteria, Ask AI across the org's corpus and
 * interview insights. This file gathers the material and
 * stores the results; the thinking happens in the AI provider, over the
 * protocol in ai-client.ts (docs/ai-protocol.md). AI_PROVIDER=mock gives a
 * deterministic offline provider for development and tests.
 */

/**
 * Criteria for a role, drafted from its posting when it has none: the
 * handful of things a recruiter would screen for, must-haves marked.
 */
export async function draftMatchCriteria(posting: {
  title: string;
  location: string | null;
  content: unknown;
}): Promise<MatchCriterion[]> {
  const { criteria } = await runAiTask('draft-criteria', {
    role: { title: posting.title, location: posting.location, content: bounded(posting.content, 12_000) },
  });
  return cleanCriteria(criteria).slice(0, MAX_CRITERIA);
}

/**
 * A posting's rich-text content, as sent to the provider: kept whole when
 * it serializes within `max` characters, otherwise sent as that much text.
 */
function bounded(content: unknown, max: number): unknown {
  const json = JSON.stringify(content ?? {});
  return json.length <= max ? (content ?? {}) : json.slice(0, max);
}

function clampResult(raw: EvaluationResult): EvaluationResult {
  const list = (v: unknown, max: number) =>
    Array.isArray(v) ? v.slice(0, max).map(String).filter(Boolean) : [];
  return {
    recommendation: Math.min(4, Math.max(1, Math.round(Number(raw.recommendation) || 3))),
    summary: String(raw.summary ?? '').slice(0, 4000),
    strengths: list(raw.strengths, 5),
    concerns: list(raw.concerns, 5),
    questions: list(raw.questions, 4),
    criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
    highlights: Array.isArray(raw.highlights) ? raw.highlights : [],
  };
}

/** The model's per-criterion answers against the role's list: every criterion once, by id. */
function scoreCriteria(criteria: MatchCriterion[], answers: EvaluationResult['criteria']): CriterionResult[] {
  const byId = new Map(
    answers
      .filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      .map((a) => [a.id.replace(/^\[|\]$/g, ''), a] as const),
  );
  return criteria.map((c) => {
    const a = byId.get(c.id);
    const evidence = typeof a?.evidence === 'string' ? a.evidence.trim().slice(0, 400) : '';
    // No evidence means the material doesn't say; that's unknown, not a zero.
    const score = a && evidence ? snapScore(a.score) : null;
    return { ...c, score, evidence };
  });
}

// ---------- AI corpus search (transcripts + resumes + notes) ----------

export type CorpusSource = {
  kind: 'transcript' | 'resume' | 'note';
  contactName: string;
  opportunityId: string | null;
  title: string;
  snippet: string;
};

export type CorpusAnswer = { answer: string; sources: CorpusSource[] };

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i in is it of on or that the their them they this to was we what when where which who with you your'.split(' '),
);

function keywords(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 8);
}

function chunkAround(text: string, terms: string[], radius = 400): string {
  const lower = text.toLowerCase();
  const idx = terms.map((t) => lower.indexOf(t)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, idx - radius);
  return text.slice(start, idx + radius);
}

/**
 * Ask a question of everything the org knows: interview transcripts,
 * resume text, and notes. Keyword retrieval picks the most relevant
 * excerpts, then the model answers ONLY from those excerpts with the
 * matching candidates cited. Swap the retriever for embeddings behind
 * this same function when the corpus outgrows keyword search.
 */
export async function askCorpus(ctx: SessionContext, question: string): Promise<CorpusAnswer> {
  if (!aiConfigured()) throw new AiUnavailableError('not_configured');
  const terms = keywords(question);
  if (!terms.length) return { answer: 'Ask a more specific question.', sources: [] };

  const termFilter = (field: 'content' | 'resumeText' | 'body') =>
    terms.map((t) => ({ [field]: { contains: t, mode: 'insensitive' as const } }));

  const [transcripts, contacts, notes] = await Promise.all([
    db.transcript.findMany({
      where: { orgId: ctx.orgId, OR: termFilter('content') },
      include: { opportunity: { include: { contact: true } } },
      take: 6,
    }),
    db.contact.findMany({
      where: { orgId: ctx.orgId, resumeText: { not: null }, OR: termFilter('resumeText') },
      include: { opportunities: { orderBy: { createdAt: 'desc' }, take: 1 } },
      take: 6,
    }),
    db.note.findMany({
      where: { orgId: ctx.orgId, OR: termFilter('body') },
      include: { opportunity: { include: { contact: true } } },
      take: 4,
    }),
  ]);

  const sources: CorpusSource[] = [
    ...transcripts.map((t) => ({
      kind: 'transcript' as const,
      contactName: t.opportunity.contact.name,
      opportunityId: t.opportunityId,
      title: t.title,
      snippet: chunkAround(t.content, terms),
    })),
    ...contacts.map((c) => ({
      kind: 'resume' as const,
      contactName: c.name,
      opportunityId: c.opportunities[0]?.id ?? null,
      title: 'Resume',
      snippet: chunkAround(c.resumeText ?? '', terms),
    })),
    ...notes.map((n) => ({
      kind: 'note' as const,
      contactName: n.opportunity.contact.name,
      opportunityId: n.opportunityId,
      title: 'Note',
      snippet: chunkAround(n.body, terms),
    })),
  ].slice(0, 10);

  if (!sources.length) {
    return { answer: 'Nothing in your transcripts, resumes, or notes matches that question.', sources: [] };
  }

  const { answer } = await runAiTask('answer', {
    question: question.slice(0, 1_000),
    excerpts: sources.map((s, i) => ({ n: i + 1, contactName: s.contactName, kind: s.kind, title: s.title, text: s.snippet })),
  });
  return { answer: String(answer ?? '').trim().slice(0, 8_000), sources };
}

/**
 * The role's criteria, drafting them from the posting the first time a
 * candidate for it is evaluated. Concurrent first evaluations (a batch)
 * draft once: only the first write lands, and everyone reads that.
 */
export async function ensurePostingCriteria(ctx: SessionContext, postingId: string): Promise<MatchCriterion[]> {
  const posting = await db.posting.findFirst({
    where: { id: postingId, orgId: ctx.orgId },
    select: { id: true, title: true, location: true, content: true, matchCriteria: true },
  });
  if (!posting) return [];
  if (posting.matchCriteria !== null) return cleanCriteria(posting.matchCriteria);
  if (!aiConfigured()) return [];
  const drafted = await draftMatchCriteria(posting);
  if (!drafted.length) return [];
  return storeDraftedCriteria(ctx, posting.id, drafted);
}

export async function evaluateOpportunity(ctx: SessionContext, opportunityId: string) {
  if (!aiConfigured()) throw new AiUnavailableError('not_configured');

  const opportunity = await db.opportunity.findFirst({
    where: { id: opportunityId, orgId: ctx.orgId },
    include: {
      contact: true,
      posting: true,
      stage: true,
      feedback: { orderBy: { createdAt: 'asc' } },
      stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      transcripts: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!opportunity) throw new Error('Opportunity not found');
  const { contact, posting } = opportunity;

  const coverNote =
    opportunity.customFields && typeof opportunity.customFields === 'object'
      ? String((opportunity.customFields as { coverNote?: string }).coverNote ?? '')
      : '';
  // Every candidate for the role is scored on the same list; the first
  // evaluation drafts it from the posting when the role has none.
  const criteria = posting ? await ensurePostingCriteria(ctx, posting.id) : [];

  const provided = await runAiTask('evaluate', {
    role: posting ? { title: posting.title, location: posting.location, content: bounded(posting.content, 20_000) } : null,
    criteria: criteria.map(({ id, label, must }) => ({ id, label, must })),
    candidate: {
      name: contact.name,
      headline: contact.headline,
      location: contact.location,
      links: contact.links.slice(0, 10),
      stage: opportunity.stage.name,
      applicationNote: coverNote ? coverNote.slice(0, 5_000) : null,
      resumeText: contact.resumeText ? contact.resumeText.slice(0, 30_000) : null,
      scorecards: opportunity.feedback.map((f) => ({ rating: f.overallRating, summary: f.summary.slice(0, 2_000) })),
      transcripts: opportunity.transcripts.slice(-8).map((t) => ({ title: t.title, content: t.content.slice(0, 15_000) })),
    },
  });

  const result = clampResult(provided.evaluation);
  const scored = scoreCriteria(criteria, result.criteria);
  const matchScore = computeMatchScore(scored);

  return db.$transaction(async (tx) => {
    const evaluation = await tx.aiEvaluation.create({
      data: {
        orgId: ctx.orgId,
        opportunityId: opportunity.id,
        model: provided.model,
        recommendation: result.recommendation,
        summary: result.summary,
        strengths: result.strengths,
        concerns: result.concerns,
        questions: result.questions,
        criteria: scored.length ? scored : undefined,
        matchScore,
        highlights: readHighlights(result.highlights),
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'ai.evaluation_completed',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { model: provided.model, recommendation: result.recommendation, matchScore },
    });
    return evaluation;
  });
}

// ---------- Interview insights ----------

/**
 * The questions asked in an interview with the candidate's answers, and the
 * few facts they stated about themselves. The transcript is untrusted text
 * (the candidate's own words are in it); the provider treats it as data.
 */
export async function extractInterviewInsights(content: string): Promise<TranscriptInsights> {
  const at = new Date().toISOString();
  const { model, qa, facts } = await runAiTask('interview-insights', { transcript: content.slice(0, 80_000) });
  const read = readInsights({ qa, facts });
  return { qa: read?.qa ?? [], facts: read?.facts ?? { ...EMPTY_FACTS }, model: String(model ?? '').slice(0, 80), at };
}
