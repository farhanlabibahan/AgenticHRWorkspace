/**
 * Resume parsing: new applicants' resumes fill in empty candidate fields,
 * using an OpenAI-compatible chat model with the operator's own key (Groq's
 * openai/gpt-oss-20b by default). Off until configured. Self-contained: it
 * shares nothing with src/server/ai.ts. See docs/resume-parsing.md.
 */
export { describeResumeParser, orgExcluded, resumeParserConfig, resumeParsingOn } from './config';
export type { ResumeParserConfig, ResumeParserDescription, ResumeParserState } from './config';
export { continueResumeParse, kickResumeParse, parseQueueFields, processResumeParse, queueResumeParse, startOfUtcDay } from './run';
export type { ResumeParseRun } from './run';
export { runResumeParseSelfTest } from './selftest';
export { resumeParseSummary } from './summary';
export type { ResumeParseSummary } from './summary';
export type { ResumeProfile } from './validate';
