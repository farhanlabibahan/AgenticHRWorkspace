import { NextResponse } from 'next/server';
import { isSnsUrl, readSesNotification, verifySnsMessage } from '@/server/sns';
import { suppressAddress } from '@/server/newsletters';

/**
 * Amazon SES bounce and complaint notifications, through SNS. Set
 * SES_SNS_TOPIC_ARN to the topic's ARN and subscribe this URL to it over
 * HTTPS; the subscription confirms itself. Without SES_SNS_TOPIC_ARN the
 * endpoint doesn't exist. Every message is checked by signature and topic
 * (src/server/sns.ts) before it's acted on.
 */
export async function POST(request: Request) {
  const topic = process.env.SES_SNS_TOPIC_ARN?.trim();
  if (!topic) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const text = await request.text();
  if (text.length > 256_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const message = await verifySnsMessage(body);
  if (!message || message.TopicArn !== topic) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  if (message.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(message.SubscribeURL)) return NextResponse.json({ error: 'bad subscribe url' }, { status: 400 });
    const res = await fetch(message.SubscribeURL!, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    return NextResponse.json({ confirmed: res.ok });
  }
  if (message.Type !== 'Notification') return NextResponse.json({ ok: true });

  const outcome = readSesNotification(message.Message);
  let suppressed = 0;
  for (const address of outcome?.addresses ?? []) suppressed += await suppressAddress(address, outcome!.kind);
  return NextResponse.json({ ok: true, suppressed });
}
