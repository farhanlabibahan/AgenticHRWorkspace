import { demoSignIn } from '@/server/demo-login';

export async function GET() {
  return demoSignIn('manager');
}
