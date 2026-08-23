import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Camera, Check, Copy, KeyRound, LogOut, Monitor, Moon, Palette, Shield, ShieldCheck, Smartphone, Sun, Trash2, User as UserIcon } from "lucide-react";
import { ApiError, del, get, patch, post, upload } from "../lib/api.ts";
import { longAgo } from "../lib/time.ts";
import { useAuth } from "../lib/auth.tsx";
import { useTheme } from "../lib/theme.tsx";
import { useToast } from "../lib/toast.tsx";
import { validateImage } from "../lib/uploadProgress.ts";
import type { Profile, UserCard, SessionSummary, TwoFactorEnrolment, TwoFactorState } from "../lib/types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { RowSkeleton, Spinner } from "../components/States.tsx";

type Section = "profile" | "privacy" | "security" | "appearance" | "account";

const SECTIONS: { id: Section; label: string; icon: typeof UserIcon }[] = [
  { id: "profile", label: "Edit profile", icon: UserIcon },
  { id: "privacy", label: "Privacy & safety", icon: Shield },
  { id: "security", label: "Security", icon: KeyRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "account", label: "Account", icon: Ban },
];

export function SettingsPage() {
  const [section, setSection] = useState<Section>("profile");

  return (
    <div className="mx-auto w-full max-w-[54rem] pb-16 sm:px-6">
      <PageHeader title="Settings" back />

      <div className="gap-8 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)]">
        <nav className="hide-scroll -mx-4 flex gap-1 overflow-x-auto px-4 pb-3 sm:mx-0 sm:flex-col sm:px-0 sm:pb-0">
          {SECTIONS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                onClick={() => setSection(entry.id)}
                className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm transition ${
                  section === entry.id ? "bg-raised font-semibold text-fg" : "text-muted hover:bg-surface hover:text-fg"
                }`}
              >
                <Icon size={16} />
                {entry.label}
              </button>
            );
          })}
        </nav>

        <div className="px-4 sm:px-0">
          {section === "profile" && <ProfileSettings />}
          {section === "privacy" && <PrivacySettings />}
          {section === "security" && <SecuritySettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "account" && <AccountSettings />}
        </div>
      </div>
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="card mb-4 p-5">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ProfileSettings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [website, setWebsite] = useState(user?.website ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [handle, setHandle] = useState<{ state: "idle" | "checking" | "free" | "taken"; reason?: string }>({ state: "idle" });

  const currentUsername = user?.username ?? "";
  const renaming = username !== currentUsername;

  // Check availability while typing so the answer arrives before Save, not after.
  useEffect(() => {
    if (!renaming) return setHandle({ state: "idle" });
    setHandle({ state: "checking" });
    const timer = setTimeout(async () => {
      try {
        const res = await get<{ available: boolean; reason: string | null }>(
          `/auth/available?username=${encodeURIComponent(username)}`,
        );
        setHandle(res.available ? { state: "free" } : { state: "taken", reason: res.reason ?? "That username is not available." });
      } catch {
        setHandle({ state: "idle" });
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [username, renaming]);

  if (!user) return null;
  const dirty =
    renaming || displayName !== user.displayName || bio !== user.bio || website !== user.website;
  const blocked = renaming && handle.state !== "free";

  async function save() {
    setBusy(true);
    try {
      const data = await patch<{ user: Profile }>("/me", {
        ...(renaming ? { username } : {}),
        displayName,
        bio,
        website,
      });
      setUser(data.user);
      setUsername(data.user.username);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast(data.user.username !== currentUsername ? `You are now @${data.user.username}` : "Profile updated", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save your profile.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function changeAvatar(file: File) {
    const error = validateImage(file);
    if (error) return toast(error, "error");
    setUploading(true);
    try {
      const body = new FormData();
      body.append("image", file, file.name);
      const data = await upload<{ user: Profile }>("/me/avatar", body);
      setUser(data.user);
      void queryClient.invalidateQueries();
      toast("Profile photo updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not upload the photo.", "error");
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    try {
      const data = await del<{ user: Profile }>("/me/avatar");
      setUser(data.user);
      void queryClient.invalidateQueries();
      toast("Profile photo removed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove the photo.", "error");
    }
  }

  return (
    <>
      <Card title="Profile photo">
        <div className="flex items-center gap-4">
          <button onClick={() => fileRef.current?.click()} className="relative" aria-label="Change profile photo">
            <Avatar user={user} size={72} link={false} />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-accent text-white">
              {uploading ? <Spinner size={11} /> : <Camera size={12} />}
            </span>
          </button>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
              Change photo
            </button>
            {user.avatar && (
              <button className="btn btn-outline" onClick={removeAvatar} disabled={uploading}>
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void changeAvatar(file);
            }}
          />
        </div>
      </Card>

      <Card title="About you">
        <div className="space-y-4">
          <Field label="Username">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">@</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 24))}
                className="field pl-7"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Username"
              />
            </div>
            {handle.state === "checking" && <p className="mt-1 text-xs text-faint">Checking…</p>}
            {handle.state === "free" && <p className="mt-1 text-xs text-online">@{username} is available.</p>}
            {handle.state === "taken" && <p className="mt-1 text-xs text-danger">{handle.reason}</p>}
            {handle.state === "idle" && (
              <p className="mt-1 text-xs text-faint">
                Changing this changes your profile link, and old links stop working. You can change it again after 14 days.
              </p>
            )}
          </Field>
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 40))}
              className="field"
              placeholder="Your name"
            />
          </Field>
          <Field label="Bio">
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value.slice(0, 300))}
              rows={3}
              className="field resize-none"
              placeholder="A line or two about you"
            />
            <p className="mt-1 text-right text-xs text-faint">{bio.length}/300</p>
          </Field>
          <Field label="Website">
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value.slice(0, 120))}
              className="field"
              placeholder="yoursite.com"
            />
          </Field>
          <div className="flex justify-end">
            <button className="btn btn-primary" onClick={save} disabled={!dirty || busy || blocked}>
              {busy ? <Spinner size={15} /> : "Save changes"}
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}

/** A labelled on/off switch, matching the private-account toggle. */
function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="rounded-xl bg-raised px-4 py-3">
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <button
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={onChange}
          disabled={disabled}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-accent" : "bg-line"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              checked ? "left-[1.375rem]" : "left-0.5"
            }`}
          />
        </button>
      </label>
      {description && <p className="mt-1.5 text-xs text-muted">{description}</p>}
    </div>
  );
}

function PrivacySettings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const blocked = useQuery({
    queryKey: ["blocked"],
    queryFn: () => get<{ users: (UserCard & { bio: string })[] }>("/me/blocked"),
  });

  const muted = useQuery({
    queryKey: ["muted"],
    queryFn: () => get<{ users: (UserCard & { bio: string })[] }>("/me/muted"),
  });

  if (!user) return null;

  /** Saves one setting and keeps the cached profile in step. */
  async function toggle(patchBody: Record<string, boolean>) {
    setBusy(true);
    try {
      const data = await patch<{ user: Profile }>("/me", patchBody);
      setUser(data.user);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      // Presence and receipts are reciprocal, so what you see changes too.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save that.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePrivate() {
    setBusy(true);
    try {
      const data = await patch<{ user: Profile }>("/me", { isPrivate: !user!.isPrivate });
      setUser(data.user);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast(data.user.isPrivate ? "Your account is now private" : "Your account is now public", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change privacy.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function unmute(id: string) {
    try {
      await del(`/users/${id}/mute`);
      void muted.refetch();
      // Their posts come back into the feeds they were hidden from.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      toast("Account unmuted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not unmute.", "error");
    }
  }

  async function unblock(id: string) {
    try {
      await del(`/users/${id}/block`);
      void blocked.refetch();
      toast("Account unblocked", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not unblock.", "error");
    }
  }

  return (
    <>
      <Card
        title="Private account"
        description="When your account is private, only followers you approve can see your posts and stories. Existing followers stay."
      >
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-raised px-4 py-3">
          <span className="text-sm font-medium">{user.isPrivate ? "Private account" : "Public account"}</span>
          <button
            role="switch"
            aria-checked={user.isPrivate}
            onClick={togglePrivate}
            disabled={busy}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${user.isPrivate ? "bg-accent" : "bg-line"}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                user.isPrivate ? "left-[1.375rem]" : "left-0.5"
              }`}
            />
          </button>
        </label>
        {user.isPrivate && (
          <p className="mt-3 text-sm text-muted">
            Pending requests appear on your{" "}
            <Link to="/notifications" className="text-accent hover:underline">
              notifications
            </Link>{" "}
            page.
          </p>
        )}
      </Card>

      <Card
        title="What others can see"
        description="Both of these work in both directions: switch one off and you stop sharing it and stop seeing it from other people."
      >
        <div className="space-y-2">
          <SwitchRow
            label="Activity status"
            description="Lets people you message see when you were last active."
            checked={user.showActivity !== false}
            disabled={busy}
            onChange={() => void toggle({ showActivity: user!.showActivity === false })}
          />
          <SwitchRow
            label="Read receipts"
            description="Shows “Seen” under a direct message once you have read it."
            checked={user.readReceipts !== false}
            disabled={busy}
            onChange={() => void toggle({ readReceipts: user!.readReceipts === false })}
          />
        </div>
      </Card>

      <Card
        title="Muted accounts"
        description="You still follow them and they are never told — their posts and stories just stop appearing in your feed."
      >
        {muted.isLoading ? (
          <RowSkeleton count={2} />
        ) : muted.data?.users.length === 0 ? (
          <p className="text-sm text-muted">You haven’t muted anyone.</p>
        ) : (
          <div className="space-y-1">
            {muted.data?.users.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 rounded-xl px-1 py-2">
                <Avatar user={entry} size={40} link={false} />
                <div className="min-w-0 flex-1">
                  <Link to={`/${entry.username}`} className="truncate text-sm font-semibold hover:underline">
                    {entry.username}
                  </Link>
                  <p className="truncate text-xs text-muted">{entry.displayName}</p>
                </div>
                <button className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={() => unmute(entry.id)}>
                  Unmute
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Blocked accounts" description="Blocked people can’t find your profile, posts or messages.">
        {blocked.isLoading ? (
          <RowSkeleton count={2} />
        ) : blocked.data?.users.length === 0 ? (
          <p className="text-sm text-muted">You haven’t blocked anyone.</p>
        ) : (
          <div className="space-y-1">
            {blocked.data?.users.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 rounded-xl px-1 py-2">
                <Avatar user={entry} size={40} link={false} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{entry.username}</p>
                  <p className="truncate text-xs text-muted">{entry.displayName}</p>
                </div>
                <button className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={() => unblock(entry.id)}>
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function AppearanceSettings() {
  const { mode, setMode } = useTheme();
  const options = [
    { value: "light" as const, label: "Light", icon: Sun },
    { value: "dark" as const, label: "Dark", icon: Moon },
    { value: "system" as const, label: "System", icon: Monitor },
  ];

  return (
    <Card title="Theme" description="Lumen follows your system setting unless you pick one here.">
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              onClick={() => setMode(option.value)}
              className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm transition ${
                mode === option.value ? "border-accent bg-accent-soft font-medium" : "border-line hover:bg-raised"
              }`}
            >
              <Icon size={18} />
              {option.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function AccountSettings() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [revoking, setRevoking] = useState(false);

  if (!user) return null;

  async function revokeOtherSessions() {
    setRevoking(true);
    try {
      await post("/auth/logout-others");
      toast("Signed out on all other devices.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not sign out other devices.", "error");
    } finally {
      setRevoking(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await post("/auth/password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      toast("Password changed. Other sessions were signed out.", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not change your password.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      // The server re-checks the password: an unattended session must not be
      // enough to destroy an account.
      await del("/me", { password: deletePassword });
      window.location.href = "/auth";
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the account.", "error");
      setDeleting(false);
    }
  }

  return (
    <>
      <Card title="Account">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Username</dt>
            <dd className="font-medium">@{user.username}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email</dt>
            <dd className="truncate font-medium">{user.email}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Change password" description="Changing your password signs out every other device.">
        <form onSubmit={changePassword} className="space-y-3">
          <Field label="Current password">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="field"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password">
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="field"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <div className="flex justify-end">
            <button className="btn btn-primary" disabled={busy || !current || next.length < 8}>
              {busy ? <Spinner size={15} /> : "Change password"}
            </button>
          </div>
        </form>
      </Card>

      <Card title="Sessions" description="Signed in somewhere you no longer trust? Sign those devices out.">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await signOut();
              navigate("/auth");
            }}
          >
            <LogOut size={15} /> Sign out
          </button>
          <button className="btn btn-outline" onClick={revokeOtherSessions} disabled={revoking}>
            {revoking ? <Spinner size={15} /> : "Sign out everywhere else"}
          </button>
        </div>
      </Card>

      <Card title="Delete account" description="This removes your profile, posts, photos, messages and follows for good.">
        <button className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
          <Trash2 size={15} /> Delete my account
        </button>
      </Card>

      <Modal
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeletePassword("");
        }}
        size="sm"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold tracking-tight">Delete your account?</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Everything you have posted — photos, comments, messages and follows — is permanently removed. This cannot be
            undone.
          </p>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Enter your password to confirm</span>
            <input
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="field"
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <div className="mt-5 flex flex-col gap-2">
            <button
              className="btn btn-danger w-full justify-center"
              onClick={deleteAccount}
              disabled={deleting || deletePassword.length === 0}
            >
              {deleting ? <Spinner size={15} /> : "Delete everything"}
            </button>
            <button
              className="btn btn-ghost w-full justify-center"
              onClick={() => {
                setDeleteOpen(false);
                setDeletePassword("");
              }}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------- security */

/**
 * Two-factor authentication and the list of signed-in devices.
 *
 * Enrolment is three steps on purpose: confirm the password, scan the code,
 * then prove the app works before anything changes. A secret that was generated
 * but never confirmed must not be able to lock anyone out of their account.
 */
function SecuritySettings() {
  const toast = useToast();

  const state = useQuery({
    queryKey: ["2fa"],
    queryFn: () => get<TwoFactorState>("/auth/2fa"),
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => get<{ sessions: SessionSummary[] }>("/auth/sessions"),
  });

  const [enrolment, setEnrolment] = useState<TwoFactorEnrolment | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const enabled = state.data?.enabled ?? false;

  async function beginSetup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      setEnrolment(await post<TwoFactorEnrolment>("/auth/2fa/setup", { password }));
      setPassword("");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not start setup.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code });
      setCodes(data.recoveryCodes);
      setEnrolment(null);
      setCode("");
      void state.refetch();
      void sessions.refetch();
      toast("Two-factor authentication is on", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not turn it on.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await post("/auth/2fa/disable", { password, code });
      setPassword("");
      setCode("");
      setDisabling(false);
      void state.refetch();
      toast("Two-factor authentication is off", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not turn it off.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    const entered = window.prompt("Enter your password to make a new set of recovery codes.");
    if (!entered) return;
    try {
      const data = await post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password: entered });
      setCodes(data.recoveryCodes);
      void state.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not make new codes.", "error");
    }
  }

  async function revoke(id: string) {
    try {
      await del(`/auth/sessions/${id}`);
      void sessions.refetch();
      toast("Signed that device out", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not sign it out.", "error");
    }
  }

  return (
    <>
      <Card
        title="Two-factor authentication"
        description="A code from your phone on top of your password, so a stolen password is not enough on its own."
      >
        {state.isLoading ? (
          <RowSkeleton count={1} />
        ) : codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : enabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3">
              <ShieldCheck size={20} className="shrink-0 text-online" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Two-factor authentication is on</p>
                <p className="text-xs text-muted">
                  {state.data?.recoveryCodesLeft ?? 0} recovery {state.data?.recoveryCodesLeft === 1 ? "code" : "codes"} left
                </p>
              </div>
            </div>

            {(state.data?.recoveryCodesLeft ?? 0) <= 3 && (
              <p className="text-sm text-warm">
                You are running low on recovery codes. Make a new set while you still have one.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ghost" onClick={() => void regenerate()}>
                New recovery codes
              </button>
              <button className="btn btn-ghost text-danger" onClick={() => setDisabling((v) => !v)}>
                Turn off
              </button>
            </div>

            {disabling && (
              <form onSubmit={turnOff} className="space-y-3 border-t border-line pt-4">
                <p className="text-sm text-muted">Both your password and a current code are needed to remove it.</p>
                <Field label="Password">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="field"
                    autoComplete="current-password"
                  />
                </Field>
                <Field label="Code from your app">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 16))}
                    className="field"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </Field>
                <button className="btn btn-danger" disabled={busy || !password || code.length < 6}>
                  {busy ? <Spinner size={15} /> : "Turn off two-factor"}
                </button>
              </form>
            )}
          </div>
        ) : enrolment ? (
          <div className="space-y-4">
            <ol className="space-y-4 text-sm">
              <li>
                <p className="font-medium">1. Scan this with your authenticator app</p>
                <div className="mt-2 inline-block rounded-xl bg-white p-3">
                  <img src={enrolment.qr} alt="Two-factor setup QR code" className="h-40 w-40" />
                </div>
              </li>
              <li>
                <p className="font-medium">Can’t scan it?</p>
                <p className="mt-1 text-muted">Enter this key by hand instead:</p>
                <code className="mt-1.5 block break-all rounded-lg bg-raised px-3 py-2 font-mono text-[13px] tracking-wider">
                  {enrolment.secret}
                </code>
              </li>
              <li>
                <p className="font-medium">2. Enter the six-digit code it shows</p>
                <form onSubmit={confirm} className="mt-2 flex gap-2">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="field max-w-[10rem] text-center text-lg tracking-[0.3em]"
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    aria-label="Six-digit code"
                  />
                  <button className="btn btn-primary" disabled={busy || code.length !== 6}>
                    {busy ? <Spinner size={15} /> : "Turn on"}
                  </button>
                </form>
              </li>
            </ol>
            <button className="text-sm text-muted hover:text-fg hover:underline" onClick={() => setEnrolment(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <form onSubmit={beginSetup} className="space-y-3">
            <p className="text-sm text-muted">
              You’ll need an authenticator app such as 1Password, Authy or Google Authenticator.
            </p>
            <Field label="Confirm your password to start">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="field"
                autoComplete="current-password"
              />
            </Field>
            <button className="btn btn-primary" disabled={busy || !password}>
              {busy ? <Spinner size={15} /> : "Set up two-factor"}
            </button>
          </form>
        )}
      </Card>

      <Card title="Where you’re signed in" description="Sign out any device you don’t recognise.">
        {sessions.isLoading ? (
          <RowSkeleton count={2} />
        ) : (
          <div className="space-y-1">
            {sessions.data?.sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-xl px-1 py-2.5">
                <Smartphone size={18} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {s.device}
                    {s.current && <span className="ml-2 text-xs font-normal text-online">This device</span>}
                  </p>
                  <p className="truncate text-xs text-muted">Last used {longAgo(s.lastUsedAt)}</p>
                </div>
                {!s.current && (
                  <button className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={() => void revoke(s.id)}>
                    Sign out
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/** Shown once, because the server only keeps hashes of these. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-warm/40 bg-warm/10 px-4 py-3">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-warm" />
        <p className="text-sm">
          Save these somewhere safe. Each one signs you in once if you lose your phone, and this is the only
          time they are shown.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-raised p-4 font-mono text-[13px]">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join("\n"));
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              toast("Could not copy. Select and copy them by hand.", "error");
            }
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? "Copied" : "Copy codes"}
        </button>
        <button className="btn btn-primary" onClick={onDone}>
          I’ve saved them
        </button>
      </div>
    </div>
  );
}
