import { describe, expect, it } from 'vitest';
import { EMPTY_FACTS, mergeFacts, qaAsText, qaFromDialogue, readInsights } from '@/lib/interview-insights';

const DIALOGUE = [
  'Interviewer: Thanks for coming in. So, can you start with the pipeline redesign?',
  'Jordan: Sure. Recruiters lost track of candidates past a few hundred.',
  'Jordan: So I built the board around stage aging.',
  'Interviewer: Great, thanks.',
  'Jordan: (laughs) No problem.',
  'Interviewer: How did you validate that?',
  'Jordan: Five recruiting teams for a month; time-to-first-touch dropped about 30%.',
  'Interviewer: Any questions for us?',
  'not a turn at all',
].join('\n');

describe('qaFromDialogue', () => {
  it('pairs each question the interviewer asks with the answer that follows', () => {
    expect(qaFromDialogue(DIALOGUE)).toEqual([
      {
        question: 'So, can you start with the pipeline redesign?',
        answer: ['Sure. Recruiters lost track of candidates past a few hundred.', 'So I built the board around stage aging.'],
      },
      { question: 'How did you validate that?', answer: ['Five recruiting teams for a month; time-to-first-touch dropped about 30%.'] },
    ]);
  });

  it('finds the interviewer by who asks first when nobody is called that', () => {
    const qa = qaFromDialogue('Sam Lee: What would you build first?\nPriya: The import path.');
    expect(qa).toEqual([{ question: 'What would you build first?', answer: ['The import path.'] }]);
    expect(qaFromDialogue('Just some notes without speakers.')).toEqual([]);
  });
});

describe('readInsights', () => {
  it('reads what it can and bounds the rest', () => {
    const read = readInsights({
      qa: [{ question: 'Why now?', answer: 'Growth.' }, { question: '', answer: ['x'] }, 3],
      facts: { location: ' Brooklyn ', workAuthorization: '', religion: 'never kept' },
      model: 'openai/gpt-oss-120b',
    });
    expect(read?.qa).toEqual([{ question: 'Why now?', answer: ['Growth.'] }]);
    expect(read?.facts).toEqual({ ...EMPTY_FACTS, location: 'Brooklyn' });
    expect(readInsights(null)).toBeNull();
  });
});

describe('facts and copy', () => {
  it('takes each fact from the newest transcript that states it', () => {
    const at = (location: string | null, availability: string | null) => ({
      qa: [],
      facts: { ...EMPTY_FACTS, location, availability },
      model: 'm',
      at: '',
    });
    const facts = mergeFacts([
      { insights: at('Austin', 'Two weeks'), title: 'Screen', createdAt: '2026-09-01T00:00:00Z' },
      { insights: at('New York', null), title: 'Onsite', createdAt: '2026-09-10T00:00:00Z' },
      { insights: null, title: 'Notes', createdAt: '2026-09-12T00:00:00Z' },
    ]);
    expect(facts.map((f) => [f.key, f.value, f.source])).toEqual([
      ['location', 'New York', 'Onsite'],
      ['availability', 'Two weeks', 'Screen'],
    ]);
  });

  it('copies as plain text', () => {
    expect(qaAsText([{ question: 'Why now?', answer: ['Growth', 'Timing'] }])).toBe('Why now?\n• Growth\n• Timing');
  });
});
