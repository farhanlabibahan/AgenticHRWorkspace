import { NextResponse } from 'next/server';
import { processWebhooks } from '@/server/webhooks';

/** Webhook dispatcher — Vercel Cron on managed, any cron + curl self-hosted. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const delivered = await processWebhooks();
  return NextResponse.json({ delivered });
}
