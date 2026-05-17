/**
 * LoginPage — Full-screen login gate for private access.
 *
 * Keeps product details off the public login screen, so tunnel visitors only see
 * a generic private-access gate before authentication.
 * Supports Enter-to-submit and auto-focuses the password input on mount.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
  error: string;
}

export function LoginPage({ onLogin, error }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(password);
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, onLogin]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--color-primary)_14%,transparent),transparent_34%),radial-gradient(circle_at_bottom_right,color-mix(in_srgb,var(--color-info)_7%,transparent),transparent_32%)]" />
      <div className="shell-panel relative w-full max-w-[min(92vw,980px)] overflow-hidden rounded-[28px]">
        <div className="grid lg:grid-cols-[1.15fr_0.85fr]">
          <div className="border-b border-border/70 bg-gradient-to-br from-background via-card/90 to-secondary/90 px-6 py-8 sm:px-8 lg:border-b-0 lg:border-r">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-background/60">
              <ShieldCheck aria-hidden="true" className="h-7 w-7 text-primary" />
            </div>
            <div className="mt-6 text-[0.667rem] font-medium uppercase tracking-[0.32em] text-primary/80">
              Private Access
            </div>
            <h1 className="mt-3 max-w-[12ch] text-4xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
              Sign in
            </h1>
            <p className="mt-4 max-w-[48ch] text-sm leading-6 text-muted-foreground sm:text-base">
              Use your private access key to continue.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Secure</div>
                <div className="mt-2 text-sm font-medium text-foreground">Private session</div>
              </div>
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Quiet</div>
                <div className="mt-2 text-sm font-medium text-foreground">Low clutter</div>
              </div>
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Ready</div>
                <div className="mt-2 text-sm font-medium text-foreground">Fast access</div>
              </div>
            </div>
          </div>

          <div className="px-6 py-8 sm:px-8">
            <div className="text-[0.667rem] font-medium uppercase tracking-[0.3em] text-primary/80">
              Locked
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-foreground">
              Enter key
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              This page is private.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-4">
              <div>
                <label htmlFor="nerve-password" className="mb-2 block text-[0.733rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Password
                </label>
                <Input
                  ref={inputRef}
                  id="nerve-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  disabled={submitting}
                />
              </div>

              {error && (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !password.trim()}
                size="lg"
                className="w-full text-[0.733rem] uppercase tracking-[0.22em]"
              >
                {submitting ? 'Checking…' : 'Continue'}
              </Button>
            </form>

            <div className="mt-6 text-xs leading-5 text-muted-foreground">
              Too many tries will pause access for a short time.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
