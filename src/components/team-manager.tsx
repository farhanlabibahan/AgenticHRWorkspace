'use client';

import { useState, useTransition } from 'react';
import { UserPlus } from 'lucide-react';
import {
  inviteUserAction,
  setUserActiveAction,
  setUserRoleAction,
} from '@/app/org-actions';
import { Dropdown } from '@/components/dropdown';
import { btnPrimary, btnTonal, inputClass, badge, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Avatar } from '@/components/ui/orb';
import { FormSelect } from '@/components/form-select';
import { TextSwap } from '@/components/ui/motion';

const ROLES = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'TEAM_MEMBER', label: 'Team member' },
  { value: 'LIMITED_TEAM_MEMBER', label: 'Limited' },
  { value: 'INTERVIEWER', label: 'Interviewer' },
];

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  TEAM_MEMBER: 'Team member',
  LIMITED_TEAM_MEMBER: 'Limited',
  INTERVIEWER: 'Interviewer',
};

export type MemberItem = {
  id: string;
  name: string;
  email: string;
  accessRole: string;
  deactivated: boolean;
  isSelf: boolean;
};

export function TeamManager({
  members,
  isAdmin,
  googleSignIn = false,
}: {
  members: MemberItem[];
  isAdmin: boolean;
  /** This deployment has "Continue with Google": invitees can use it too. */
  googleSignIn?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('TEAM_MEMBER');
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {tempPassword ? (
        <div className="rounded-field bg-positive/10 p-3">
          <p className="text-sm font-medium text-positive">
            Temporary password — share it securely, shown once. They sign in with it and should
            change it.
            {googleSignIn
              ? ' If that address is on Gmail or Google Workspace, they can use Continue with Google instead.'
              : null}
          </p>
          <code className="mt-1.5 block select-all break-all rounded-field bg-surface px-2 py-1.5 font-mono text-xs">
            {tempPassword}
          </code>
        </div>
      ) : null}

      <div className="flex flex-col divide-y divide-line">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name={m.name} size={32} className={m.deactivated ? 'opacity-40' : undefined} />
              <div className="min-w-0">
                <p className={`truncate text-sm font-medium ${m.deactivated ? 'text-ink-2 line-through' : ''}`}>
                  {m.name}
                </p>
                <p className="truncate text-xs text-ink-2">{m.email}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isAdmin && m.accessRole !== 'SUPER_ADMIN' && !m.isSelf ? (
                <>
                  <Dropdown
                    compact
                    onSurface
                    disabled={pending || m.deactivated}
                    label={ROLE_LABELS[m.accessRole] ?? m.accessRole}
                    showSelectedInTrigger={false}
                    value={m.accessRole}
                    options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
                    onSelect={(next) => {
                      if (next && next !== m.accessRole)
                        startTransition(() => setUserRoleAction(m.id, next));
                    }}
                  />
                  <button
                    disabled={pending}
                    onClick={() => startTransition(() => setUserActiveAction(m.id, m.deactivated))}
                    className={buttonClass({ variant: 'ghost', size: 'xs' })}
                  >
                    {m.deactivated ? 'Reactivate' : 'Deactivate'}
                  </button>
                </>
              ) : (
                <span className={badge}>{ROLE_LABELS[m.accessRole] ?? m.accessRole}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {isAdmin ? (
        inviting ? (
          <form
            className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await inviteUserAction(name, email, role);
                if (result.tempPassword) {
                  setTempPassword(result.tempPassword);
                  setName('');
                  setEmail('');
                  setInviting(false);
                  setError(null);
                } else setError(result.error ?? 'Failed');
              });
            }}
          >
            <input {...noAutofill}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Full name"
              className={inputClass}
            />
            <input {...noAutofill}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="teammate@company.com"
              className={inputClass}
            />
            <FormSelect value={role} onChange={setRole} options={ROLES} />
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Inviting…' : 'Invite'}</TextSwap>
            </button>
          </form>
        ) : (
          <div className="border-t border-line pt-3">
            <button onClick={() => setInviting(true)} className={btnTonal}>
              <UserPlus /> Invite teammate
            </button>
          </div>
        )
      ) : null}
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </div>
  );
}
