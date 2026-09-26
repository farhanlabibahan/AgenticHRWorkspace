/**
 * "Get started" from /agencies signs up a staffing agency. The kind rides
 * along as ?kind=agency, and through Google's round trip in this cookie
 * (set by googleSignIn, read by /signup/finish).
 */
export const SIGNUP_KIND_COOKIE = 'source-signup-kind';

/** Where "Get started" goes from each version of the homepage. */
export const signupHref = (agency: boolean) => (agency ? '/signup?kind=agency' : '/signup');
