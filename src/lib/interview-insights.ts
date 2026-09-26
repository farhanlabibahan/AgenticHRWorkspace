/**
 * What an interview transcript says, pulled out (Transcript.insights): the
 * questions asked with the candidate's answers, and a few facts the
 * candidate stated. Read defensively: the column is JSON.
 */

export type InterviewQA = { question: string; answer: string[] };

export type InterviewFacts = {
  motivation: string | null;
  location: string | null;
  relocation: string | null;
  workAuthorization: string | null;
  availability: string | null;
};

export type TranscriptInsights = {
  qa: InterviewQA[];
  facts: InterviewFacts;
  model: string;
  at: string;
};

export const FACT_LABELS: [keyof InterviewFacts, string][] = [
  ['motivation', 'Why they’re looking'],
  ['location', 'Based in'],
  ['relocation', 'Relocation'],
  ['workAuthorization', 'Work authorization'],
  ['availability', 'Availability'],
];

export const EMPTY_FACTS: InterviewFacts = {
  motivation: null,
  location: null,
  relocation: null,
  workAuthorization: null,
  availability: null,
};

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function readInsights(raw: unknown): TranscriptInsights | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const qa = Array.isArray(r.qa)
    ? r.qa
        .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
        .map((q) => ({
          question: str(q.question, 300) ?? '',
          answer: (Array.isArray(q.answer) ? q.answer : [q.answer]).map((a) => str(a, 600)).filter((a): a is string => !!a).slice(0, 4),
        }))
        .filter((q) => q.question && q.answer.length)
        .slice(0, 15)
    : [];
  const f = r.facts && typeof r.facts === 'object' ? (r.facts as Record<string, unknown>) : {};
  const facts = Object.fromEntries(FACT_LABELS.map(([key]) => [key, str(f[key], 200)])) as InterviewFacts;
  return { qa, facts, model: str(r.model, 80) ?? '', at: str(r.at, 40) ?? '' };
}

const TURN = /^\s*([A-Z][\w .’'-]{0,40}?)\s*:\s*(.+)$/;

/**
 * Questions and answers from a transcript written as "Speaker: words"
 * lines, without a model: the interviewer is the speaker named so, or the
 * first to ask a question. Each question they ask starts an entry; the
 * other side's lines until their next turn are the answer.
 */
export function qaFromDialogue(content: string): InterviewQA[] {
  const turns = content
    .split(/\r?\n/)
    .map((line) => line.match(TURN))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ speaker: m[1].trim(), text: m[2].trim() }));
  const interviewer =
    turns.find((t) => /^interviewer$/i.test(t.speaker))?.speaker ?? turns.find((t) => t.text.includes('?'))?.speaker;
  if (!interviewer) return [];
  const out: InterviewQA[] = [];
  let current: InterviewQA | null = null;
  for (const t of turns) {
    if (t.speaker === interviewer) {
      if (t.text.includes('?')) {
        // The question itself: the last sentence that asks something.
        const asked = t.text.match(/[^.?!]*\?/g)?.pop()?.trim() ?? t.text;
        current = { question: asked.slice(0, 300), answer: [] };
        out.push(current);
      } else current = null;
    } else if (current) {
      current.answer.push(t.text.slice(0, 600));
    }
  }
  return out.filter((q) => q.answer.length).slice(0, 15);
}

/** Q&A as plain text, for Copy. */
export function qaAsText(qa: InterviewQA[]): string {
  return qa.map((q) => `${q.question}\n${q.answer.map((a) => `• ${a}`).join('\n')}`).join('\n\n');
}

export type KeyFact = { key: keyof InterviewFacts; label: string; value: string; source: string; date: string };

/** Each fact from the most recent transcript that states it. */
export function mergeFacts(transcripts: { insights: TranscriptInsights | null; title: string; createdAt: string }[]): KeyFact[] {
  const newestFirst = [...transcripts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out: KeyFact[] = [];
  for (const [key, label] of FACT_LABELS) {
    const from = newestFirst.find((t) => t.insights?.facts[key]);
    if (from) out.push({ key, label, value: from.insights!.facts[key]!, source: from.title, date: from.createdAt });
  }
  return out;
}
