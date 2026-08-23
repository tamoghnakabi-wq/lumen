import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, Eye, EyeOff, X } from "lucide-react";
import { ApiError, get, post } from "../lib/api.ts";
import { useAuth, type TwoFactorChallenge } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import { Wordmark } from "../components/Wordmark.tsx";
import { Spinner } from "../components/States.tsx";

type Mode = "signin" | "signup";

export function AuthPage() {
  const { user, loading, signIn, completeTwoFactor, signUp } = useAuth();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Set when the password was right but the account also wants a code.
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<{ ok: boolean; reason: string | null } | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);

  // Live username availability, debounced.
  useEffect(() => {
    if (mode !== "signup" || username.trim().length < 3) {
      setAvailable(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const data = await get<{ available: boolean; reason: string | null }>(
          `/auth/available?username=${encodeURIComponent(username.trim())}`,
        );
        setAvailable({ ok: data.available, reason: data.reason });
      } catch {
        setAvailable(null);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [username, mode]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner size={22} />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const pending = await signIn(identifier.trim(), password);
        if (pending) {
          // Nothing is signed in yet; the code step takes over from here.
          setChallenge(pending);
          setPassword("");
          return;
        }
      } else {
        await signUp({
          username: username.trim().toLowerCase(),
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setParams(next === "signup" ? { mode: "signup" } : {}, { replace: true });
  }

  if (challenge) {
    return (
      <div className="grid min-h-dvh lg:grid-cols-[1.05fr_minmax(26rem,0.95fr)]">
        <AuthArt />
        <div className="flex items-center justify-center px-5 py-10 sm:px-10">
          <TwoFactorStep
            challenge={challenge}
            onVerify={completeTwoFactor}
            onCancel={() => {
              setChallenge(null);
              setError(null);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_minmax(26rem,0.95fr)]">
      <AuthArt />

      <div className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden">
            <Wordmark className="mb-6" />
          </div>

          <h1 className="text-[27px] font-semibold leading-tight tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {mode === "signin"
              ? "Sign in to see what the people you follow have been making."
              : "Pick a username — it’s how people will find you."}
          </p>

          {/* Native validation catches empties and malformed emails without a round trip;
              anything subtler comes back from the server. */}
          <form onSubmit={submit} className="mt-7 space-y-3">
            {mode === "signin" ? (
              <div>
                <label htmlFor="identifier" className="mb-1.5 block text-xs font-medium text-muted">
                  Username or email
                </label>
                <input
                  id="identifier"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                  className="field"
                  placeholder="mara"
                />
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="username" className="mb-1.5 block text-xs font-medium text-muted">
                    Username
                  </label>
                  <div className="relative">
                    <input
                      id="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))}
                      autoComplete="username"
                      autoCapitalize="none"
                      required
                      className={`field pr-9 ${available && !available.ok ? "field-error" : ""}`}
                      placeholder="yourname"
                    />
                    {available && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2">
                        {available.ok ? (
                          <Check size={16} className="text-online" />
                        ) : (
                          <X size={16} className="text-danger" />
                        )}
                      </span>
                    )}
                  </div>
                  {available?.reason && <p className="mt-1 text-xs text-danger">{available.reason}</p>}
                </div>
                <div>
                  <label htmlFor="displayName" className="mb-1.5 block text-xs font-medium text-muted">
                    Display name <span className="text-faint">(optional)</span>
                  </label>
                  <input
                    id="displayName"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    className="field"
                    placeholder="Mara Voss"
                  />
                </div>
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-muted">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                    className="field"
                    placeholder="you@example.com"
                  />
                </div>
              </>
            )}

            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-muted">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "signup" ? 8 : undefined}
                  className="field pr-10"
                  placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition hover:text-fg"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full justify-center py-2.5" disabled={busy}>
              {busy ? <Spinner size={16} /> : mode === "signin" ? "Sign in" : "Create account"}
              {!busy && <ArrowRight size={16} />}
            </button>
          </form>

          {mode === "signin" && (
            <button
              onClick={() => setForgotOpen(true)}
              className="mt-3 block w-full text-center text-sm text-muted transition hover:text-fg"
            >
              Forgot your password?
            </button>
          )}

          <p className="mt-6 text-center text-sm text-muted">
            {mode === "signin" ? "New to Lumen?" : "Already have an account?"}{" "}
            <button
              onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
              className="font-semibold text-accent hover:underline"
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>

          <p className="mt-8 text-center text-xs leading-relaxed text-faint">
            By continuing you agree to be decent to other people.
          </p>
        </div>
      </div>

      <ForgotPasswordDialog open={forgotOpen} onClose={() => setForgotOpen(false)} />
    </div>
  );
}

function AuthArt() {
  return (
    <div className="relative hidden overflow-hidden bg-[#0b0b10] lg:block">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 55% at 22% 22%, rgba(124,92,255,0.55), transparent 62%)," +
            "radial-gradient(55% 50% at 78% 32%, rgba(255,122,89,0.42), transparent 60%)," +
            "radial-gradient(70% 60% at 55% 92%, rgba(75,200,255,0.32), transparent 64%)",
        }}
      />
      <div className="relative flex h-full flex-col justify-between p-12">
        <Wordmark className="[&_span]:text-white [&_span]:text-[22px]" />
        <div className="max-w-md">
          <h2 className="text-[40px] font-semibold leading-[1.08] tracking-tight text-white">
            A quieter place for the pictures you actually care about.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">
            Follow the people whose work you like. Post when you have something worth posting. No ads, no algorithm
            shouting at you.
          </p>
        </div>
        <p className="text-xs text-white/40">Lumen · built for people who take pictures</p>
      </div>
    </div>
  );
}

function ForgotPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ message: string; link?: string } | null>(null);
  const toast = useToast();

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await post<{ message: string; link?: string }>("/auth/forgot", { email: email.trim() });
      setSent(data);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send reset link.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-5">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <h2 className="text-lg font-semibold tracking-tight">Reset your password</h2>
        {sent ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm leading-relaxed text-muted">{sent.message}</p>
            {sent.link ? (
              <a href={sent.link} className="block break-all rounded-lg bg-raised p-3 text-xs text-accent hover:underline">
                {sent.link}
              </a>
            ) : (
              <p className="rounded-lg bg-raised p-3 text-xs leading-relaxed text-muted">
                This install has no mail service, so the reset link is printed in the server console and appended to
                <code className="mx-1 rounded bg-surface px-1 py-0.5">data/password-resets.log</code>.
              </p>
            )}
            <button className="btn btn-ghost w-full justify-center" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-3">
            <p className="text-sm text-muted">We’ll create a reset link for the account with this email.</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@example.com"
              className="field"
            />
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost flex-1 justify-center" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary flex-1 justify-center" disabled={busy}>
                {busy ? <Spinner size={15} /> : "Send link"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { refresh } = useAuth();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/reset", { token, password });
      await refresh();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-7" />
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        {!token ? (
          <p className="mt-3 text-sm text-muted">
            This link is missing its token.{" "}
            <Link to="/auth" className="text-accent hover:underline">
              Back to sign in
            </Link>
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
              placeholder="At least 8 characters"
              className="field"
              autoComplete="new-password"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn btn-primary w-full justify-center" disabled={busy}>
              {busy ? <Spinner size={15} /> : "Set new password"}
            </button>
            <p className="text-center text-xs text-muted">Setting a new password signs you out everywhere else.</p>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * The second step of a sign-in.
 *
 * Reached only after the password was accepted, and it holds nothing but a
 * short-lived challenge — no session exists until a code is verified, so
 * abandoning this screen leaves the account untouched.
 */
function TwoFactorStep({
  challenge,
  onVerify,
  onCancel,
}: {
  challenge: TwoFactorChallenge;
  onVerify: (challenge: string, code: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onVerify(challenge.challenge, code.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again.");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="lg:hidden">
        <Wordmark className="mb-6" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Enter your code</h1>
      <p className="mt-1.5 text-sm text-muted">
        {useRecovery
          ? "Type one of the recovery codes you saved when you turned this on."
          : "Open your authenticator app and enter the six-digit code for Lumen."}
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          value={code}
          onChange={(e) =>
            setCode(useRecovery ? e.target.value.slice(0, 16) : e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          className={`field text-center tracking-[0.4em] ${useRecovery ? "tracking-normal" : "text-lg"}`}
          placeholder={useRecovery ? "xxxxx-xxxxx" : "000000"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          aria-label={useRecovery ? "Recovery code" : "Six-digit code"}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          className="btn btn-primary w-full justify-center"
          disabled={busy || code.trim().length < 6}
        >
          {busy ? <Spinner size={15} /> : "Verify"}
        </button>
      </form>

      <div className="mt-5 space-y-2 text-sm">
        {challenge.recoveryAvailable && (
          <button
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode("");
              setError(null);
            }}
            className="text-accent hover:underline"
          >
            {useRecovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
          </button>
        )}
        <div>
          <button onClick={onCancel} className="text-muted hover:text-fg hover:underline">
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}
