import { demoSignIn } from '@/server/demo-login';

// Legacy address used by the marketing links: the manager demo.
export async function GET() {
  return demoSignIn('manager');
}
