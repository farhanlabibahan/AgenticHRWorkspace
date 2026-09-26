# Resume parsing

Source reads the text of every resume itself, with open-source libraries and no outside service (see [03-architecture.md](03-architecture.md)). Resume parsing is an optional step on top of that: a language model reads a new applicant's resume and fills in the candidate fields that are still empty. It uses your own model key, and it is off until you set one.

- [What it does](#what-it-does)
- [When it runs](#when-it-runs)
- [Turn it on with Groq](#turn-it-on-with-groq)
- [Other providers](#other-providers)
- [Check your setup](#check-your-setup)
- [What gets filled, and what never changes](#what-gets-filled-and-what-never-changes)
- [Limits and cost](#limits-and-cost)
- [Privacy](#privacy)
- [The cron](#the-cron)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)

## What it does

When someone applies through your careers page with a resume, the model reads the resume's text and returns a structured profile: name, headline, location, contact details, a summary, skills, work history and education. Source checks every field against the resume, then:

- fills in the candidate's **headline** and **location** if they are empty
- adds **phone numbers** and **profile links** (LinkedIn, GitHub and the like) if the application brought none
- keeps the whole checked profile with the resume file, for the candidate page to show later

Nothing anyone typed is overwritten. Parsing never moves a candidate, sends an email, adds a tag or creates a task.

## When it runs

Parsing happens in the background, never while the applicant waits: the application is saved, the applicant sees their confirmation, and then the resume is sent to the model, usually within a second or two. A cron (below) picks up anything that couldn't be done right away, for example because the provider was down.

Only resumes from **new careers-page applications** are parsed. Imports from another ATS, CSV imports and resumes already in Source are never sent anywhere.

## Turn it on with Groq

The default is OpenAI's open-weight model **gpt-oss-20b**, hosted by [Groq](https://groq.com).

1. Create a key at [console.groq.com/keys](https://console.groq.com/keys).
2. Set it in your environment and restart Source:

   ```bash
   GROQ_API_KEY=gsk_...
   ```

3. Open **Settings → Integrations**. Resume parsing shows **On**, with Groq and the model.
4. [Check your setup](#check-your-setup) with a made-up resume.

To use the larger model (better on unusual layouts, about twice the price):

```bash
RESUME_PARSER_MODEL=openai/gpt-oss-120b
```

Groq's free tier allows about 40 resumes a day. Treat it as a trial; a paid plan removes the limit that matters here.

## Other providers

Any endpoint that speaks the OpenAI chat completions API works. Set its base URL, and a key if it needs one:

| Provider | `RESUME_PARSER_BASE_URL` | `RESUME_PARSER_MODEL` | Key |
|---|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` (default) | `GROQ_API_KEY` or `RESUME_PARSER_API_KEY` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | `openai/gpt-oss-20b` (default) | `RESUME_PARSER_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-oss-20b` (default) | `RESUME_PARSER_API_KEY` |
| Ollama on your own server | `http://localhost:11434/v1` | `gpt-oss:20b` | none |

**OpenRouter** routes each request to one of several hosts. Source asks only for hosts that support every parameter it sends (so the answer follows the JSON schema) and that don't collect data. To control which companies can serve your requests, set allowed providers in your OpenRouter account.

**A model on your own server (Ollama)** keeps resumes on your network:

1. `ollama pull gpt-oss:20b`. It is a 14 GB download and needs 16 GB of memory or more.
2. Start Ollama with a larger context: `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`. The default of 4096 tokens on smaller machines silently cuts long resumes off.
3. Point Source at it and give the model time to answer:

   ```bash
   RESUME_PARSER_BASE_URL=http://localhost:11434/v1   # in Docker: http://host.docker.internal:11434/v1
   RESUME_PARSER_MODEL=gpt-oss:20b
   RESUME_PARSER_TIMEOUT_MS=120000
   ```

   With docker-compose on Linux, `host.docker.internal` also needs `extra_hosts: ["host.docker.internal:host-gateway"]` on the app service (it's in `docker-compose.yml`, commented out).

**Other open models**, such as Gemma, Llama, Mistral, Phi or Granite, work too if your endpoint supports JSON-schema output (`response_format` with `json_schema`). Source falls back to plain JSON mode when an endpoint doesn't, and checks every field either way, but results are best with schema support.

## Check your setup

Once a key is set, parse a built-in, made-up resume through your provider. No candidate data is read or written:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://your-source/api/cron/resume-parse?selftest=1"
```

Keep the quotes: without them zsh (the macOS shell) reads the `?` as a filename pattern. The self-test makes a real call on your key, so it needs `CRON_SECRET` to be set (it answers `403` otherwise, even where the cron itself is left open), and only one runs at a time (`429` while another is running).

The answer shows whether it worked (`"ok": true`), which fields came back, how many tokens it used and how long it took. If it failed, `code` says why; see [Troubleshooting](#troubleshooting).

## What gets filled, and what never changes

| Field | Filled when | Rule |
|---|---|---|
| Headline | it is empty | The headline must appear in the resume as whole words, or the current role's title and company must. Never a phone number, email address or link. |
| Location | it is empty | Must appear in the resume as whole words, and not be a contact detail. |
| Phone numbers | the candidate has none | At most 3, each one written in the resume digit group for digit group. Dates, year ranges and ID numbers are rejected. |
| Links | the candidate has none | Profile links only (LinkedIn, GitHub, GitLab, Behance, Dribbble and similar), each one written out in the resume. A company's website is never added: duplicate detection matches candidates on links. |

Never changed: the candidate's **name** and **email addresses**, **tags**, anything on an application (stage, source, custom fields) and any other candidate. Emails are how a new application finds an existing candidate, and resumes list other people's addresses (references, managers), so an address from a resume could attach a stranger's application to the wrong person.

If someone edits the candidate while their resume is being read, their edit wins. A resume is parsed once; a candidate who applies again with a new resume gets that one parsed too, and it still only fills what is empty.

Each fill is recorded in the audit log (**Settings → Data & privacy → Audit log**, verb `contact.resume_parsed`) with the names of the fields it filled, never their values.

## Limits and cost

| Setting | Default | What it does |
|---|---|---|
| `RESUME_PARSER_DAILY_LIMIT` | `500` | Attempts per organization per day (UTC): one per resume, unless a resume has to be tried again, which counts again. Anything over waits for the next day; `0` pauses parsing. |
| `RESUME_PARSER_GLOBAL_DAILY_LIMIT` | none | Attempts per day across all organizations on this server. |
| `RESUME_PARSER_EXCLUDE_ORGS` | none | Organization ids or slugs, separated by commas, that are never parsed (for example a customer who objects to the provider). Their queued resumes are dropped. |
| `RESUME_PARSER_MAX_CHARS` | `12000` | How much of each resume is sent (about 3,000 tokens of English). Scripts that use more tokens per character are cut sooner. |
| `RESUME_PARSER_TIMEOUT_MS` | `20000` | How long one request may take. Use `120000` for a model on your own server. |

Each resume uses about 3,000 input tokens and 1,200 output tokens. At Groq's prices in September 2026 ($0.075 per million input tokens and $0.30 per million output tokens for gpt-oss-20b) that is about **$0.0006 a resume**, or about $0.30 a day per organization at the default limit. The worst case is higher: an attempt makes at most three calls, and a resume that makes the model write until it runs out of room (by accident, or on purpose) costs about $0.005 an attempt, so at most about $2.50 a day per organization at the default limit. gpt-oss-120b costs about twice as much. Size `RESUME_PARSER_GLOBAL_DAILY_LIMIT` from the worst case.

A resume the model can't handle is tried up to 3 times, 15 minutes apart. Problems with the provider or your account (a rejected key, a retired model, no credit left, a rate limit) don't use up those attempts: parsing pauses and resumes on its own. Some failures could be the provider's or the resume's (a server error, no answer in time): that resume gets its attempt back and waits 15 minutes while the next one is tried, so one resume that crashes a model doesn't hold up the others, and two in a row pause parsing until the provider is back. A resume only gets its attempt back this way in its first 4 hours in the queue, so one that always fails is still given up on. A resume still waiting after 72 hours is dropped.

## Privacy

When parsing is on, the only thing sent is the **extracted text of new applicants' resumes**, to the provider you configured. The file itself, cover notes, EEO answers and other fields are never sent. With a model on your own server, nothing leaves your network.

Providers keep data differently:

- **Groq** doesn't retain inference data by default. It may keep limited logs for up to 30 days for reliability and abuse monitoring, unless you turn on Zero Data Retention (console.groq.com → Settings → Data controls).
- **DeepInfra** says it doesn't store inputs or outputs and doesn't train on them (see its data-privacy page).
- **OpenRouter**: Source asks for hosts that don't collect data. Set allowed providers in your account to choose which companies serve your requests.

Tell candidates in your privacy notice that you use your provider to process applications, and list it as a subprocessor if you keep such a list.

The parsed profile is stored with the resume file. It is included in the candidate's data export (the SAR download on the candidate page) and deleted with the file when the candidate is anonymized. Logs record ids, counts and error codes, never resume text or field values.

## The cron

`/api/cron/resume-parse` picks up anything the after-apply step didn't finish. On Vercel it runs every 10 minutes from `vercel.json`, and the docker-compose `cron` service already calls it. Elsewhere, call it every 10 minutes:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://your-source/api/cron/resume-parse"
```

With parsing off it answers `{"state":"off"}` and does nothing.

A run stops after 4 minutes. With work left, it starts the next run itself: through its own cron route when `CRON_SECRET` is set, or else in the same process, up to 10 runs in a row. Set `CRON_SECRET` anyway: without it the cron routes are open to anyone who can reach your server, and the self-test won't run.

## Settings

All environment variables, read when a resume is parsed:

| Variable | Meaning |
|---|---|
| `GROQ_API_KEY` | Turns parsing on with Groq. |
| `RESUME_PARSER_BASE_URL` | Any OpenAI-compatible endpoint instead of Groq. http or https, no username or password, no query string. |
| `RESUME_PARSER_API_KEY` | The key for that endpoint. Takes precedence over `GROQ_API_KEY`. Not needed for your own Ollama. |
| `RESUME_PARSER_MODEL` | The model. Defaults to `openai/gpt-oss-20b` on Groq, DeepInfra and OpenRouter; required for any other endpoint. |
| `RESUME_PARSER=off` | Turns parsing off without removing the key. |
| `RESUME_PARSER_DAILY_LIMIT`, `RESUME_PARSER_GLOBAL_DAILY_LIMIT`, `RESUME_PARSER_EXCLUDE_ORGS`, `RESUME_PARSER_MAX_CHARS`, `RESUME_PARSER_TIMEOUT_MS` | See [Limits and cost](#limits-and-cost). |

## Troubleshooting

Settings → Integrations → Resume parsing shows what's wrong. The self-test and the logs (`[resume-parse]` lines) show the same codes.

| Settings says | Code | Fix |
|---|---|---|
| "RESUME_PARSER_BASE_URL is set, but no model is." | `model_required` | Set `RESUME_PARSER_MODEL`, for example `gpt-oss:20b` on Ollama. |
| "RESUME_PARSER_BASE_URL isn't a valid http or https URL." | `bad_base_url` | Use a plain `https://host/path` or `http://host:port/v1`, with no credentials or query string. |
| "{host} needs an API key." | `key_required` | Set `RESUME_PARSER_API_KEY`. `GROQ_API_KEY` is only sent to Groq. |
| "{provider} rejected the API key." | `provider_auth` | Check the key, and that it belongs to the provider in `RESUME_PARSER_BASE_URL`. Parsing resumes on its own once the key works. |
| "{provider} doesn't recognize the model {model}." | `provider_not_found` | Check `RESUME_PARSER_MODEL` against the provider's model list (Ollama: `ollama list`). |
| "{provider} has retired the model {model}." | `provider_model_retired` | Set `RESUME_PARSER_MODEL` to a model the provider still serves. |
| "{provider} says the account is out of credit or over its quota." | `provider_quota` | Top up or raise the limit in the provider's console. Waiting resumes are parsed once it works. |
| "{provider} is limiting requests." | `provider_rate_limited` | Nothing to do: waiting resumes are parsed as the limit resets. On Groq's free tier, consider a paid plan. |
| "{provider} isn't answering." | `provider_unavailable` | The provider is down or unreachable. Check the URL, and for your own server that it's running. |
| "{provider} isn't answering in time." | `provider_timeout` | Several resumes in a row got no answer in time. For your own server, check it's running and raise `RESUME_PARSER_TIMEOUT_MS`. |
| "{provider} is turning down requests for the model {model}." | `provider_bad_request` | Several resumes in a row got a 400 Source doesn't recognize. Check the model and endpoint; the logs have the HTTP status. |
| "{provider} answered with a redirect instead of a result." | `provider_redirect` | `RESUME_PARSER_BASE_URL` points at the wrong place (often a missing `/v1`). Source never follows redirects with your key. |
| "Resumes are too long for your plan's per-request limit." | `provider_too_large` | Lower `RESUME_PARSER_MAX_CHARS`, for example to `8000`. |
| "The model took too long to answer." | `provider_timeout` | For a model on your own server, raise `RESUME_PARSER_TIMEOUT_MS` (up to `200000`). |
| "The model's answer for some resumes couldn't be used." | `provider_bad_json`, `provider_truncated`, `provider_empty`, `provider_bad_request` | Usually a model without JSON-schema support, or one too small for the task. Try gpt-oss-20b. |
| "Today's limit of 500 resumes is reached." | | The rest are parsed tomorrow (UTC). Raise `RESUME_PARSER_DAILY_LIMIT` if that's expected volume. |
| "Off for this workspace" | `org_off` | The organization is in `RESUME_PARSER_EXCLUDE_ORGS`. |
