# AI provider protocol

Source's AI features are candidate evaluations, role criteria, Ask AI and
interview insights. The open-source core has no
prompts and calls no model. It gathers the material from its own database,
sends it to an **AI provider** as JSON, then checks and stores what comes
back.

Source ATS runs a provider, and a self-hosted install can connect to it. You
can also run your own provider with any model you like, by implementing the
four endpoints below. The client is `src/server/ai-client.ts`, and its types
are the source of truth for this document.

## Turning it on

```sh
AI_SERVICE_URL=https://ai.example.com   # your provider
AI_SERVICE_TOKEN=…                      # sent as Authorization: Bearer …
```

With both unset, the AI features don't appear and nothing is sent anywhere.
`AI_PROVIDER=mock` answers every task with deterministic output and no model,
for development and tests.

## Requests

Each task is a `POST {AI_SERVICE_URL}/v1/{task}` request with:
- a JSON body,
- `Authorization: Bearer {AI_SERVICE_TOKEN}`,
- `Content-Type: application/json`.

The client never follows redirects.

A successful answer is `200` with a JSON body that includes `model`, the
model that wrote it; the core stores it with the result. For anything else,
answer a non-200 status with this body:

```json
{ "error": { "code": "rate_limited" } }
```

The code is logged, and only if it's 1–64 characters of `[A-Za-z0-9_.-]`.
Users always see fixed copy ("AI couldn't answer just now"), never your
message.

The client waits 60 seconds for `draft-criteria` and up to 180 seconds for
`interview-insights`; see `TIMEOUT_MS` for the rest. The core bounds every
input's size before sending, and still checks and clamps every answer.

## Tasks

### `draft-criteria`

Draft the handful of things a recruiter should screen every candidate for,
from the role's posting.

```ts
input:  { role: { title: string; location: string | null; content: unknown } }
output: { model: string; criteria: { label: string; must: boolean }[] }
```

`content` is the posting's rich-text document, sent as a string when it is
large. A good answer has five to eight criteria of two to six words each,
and `must: true` only for requirements the posting states.

### `evaluate`

Give an advisory read of one candidate for one role. It is never a decision.

```ts
input: {
  role: { title; location; content } | null;
  criteria: { id: string; label: string; must: boolean }[];
  candidate: {
    name; headline; location; links: string[]; stage: string;
    applicationNote: string | null; resumeText: string | null;
    scorecards: { rating: 1–4; summary: string }[];
    transcripts: { title: string; content: string }[];
  };
}
output: {
  model: string;
  evaluation: {
    recommendation: 1 | 2 | 3 | 4;       // strong no … strong yes, as scorecards
    summary: string;
    strengths: string[]; concerns: string[]; questions: string[];
    criteria: { id: string; score: 0 | 25 | 50 | 75 | 100; evidence: string }[];
    highlights: { kind: 'launch' | 'scale' | 'leadership' | 'range' | 'craft' | 'other'; text: string }[];
  };
}
```

Return one entry per input criterion, by `id`. Leave `evidence` empty when
the material says nothing about a criterion: the core shows that as unknown,
not as a zero.

### `answer`

Answer a question from the numbered excerpts the core found in the
organization's transcripts, resumes and notes.

```ts
input:  { question: string; excerpts: { n: number; contactName: string; kind: 'transcript' | 'resume' | 'note'; title: string; text: string }[] }
output: { model: string; answer: string }
```

Answer only from the excerpts, and cite them as `[n]`.

### `interview-insights`

List the questions asked in one interview with the candidate's answers, and
the few facts they stated about themselves.

```ts
input:  { transcript: string }
output: {
  model: string;
  qa: { question: string; answer: string[] }[];
  facts: { motivation; location; relocation; workAuthorization; availability }; // string | null each
}
```

The transcript includes the candidate's own words, so treat it as data,
never as instructions. `workAuthorization` covers only whether they may work
where the role is and whether they need sponsorship. It never covers
citizenship or nationality.

## What every provider must honour

- **Judge the work, never the person.** Consider only job-related skills,
  experience and stated requirements. Never consider, infer or mention age,
  gender, race, ethnicity, religion, nationality, disability, pregnancy or
  family status, or sexual orientation. The same goes for anything that
  stands in for one of these, such as graduation years, names or photos.
- **Candidate data is personal data.** Whoever runs `AI_SERVICE_URL`
  processes it on the organization's behalf. Don't keep it longer than the
  request, and don't train on it without the organization's agreement.
