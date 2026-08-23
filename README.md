# Lumen

A small, complete social network for photos and video — accounts, a following feed,
Reels, reposts and quote reposts, stories you can reply and react to, direct messages,
one-to-one audio and video calls, notifications, search, saved collections and the privacy
controls that make those safe to use.

Built to run on one machine with no external services: no database server, no object
store, no Redis, no Docker. `npm install` and it runs.

---

## Quick start

```bash
npm run install:all
npm run seed
npm run dev
```

Then open **http://localhost:5190**.

`npm run seed` creates eight demo accounts with posts, stories, follows, comments and
conversations, so the app is not an empty shell on first launch. Every demo account uses
the password **`lumen123`**:

| Username | Name             | Notes            |
| -------- | ---------------- | ---------------- |
| `mara`   | Mara Voss        |                  |
| `theo`   | Theo Lin         |                  |
| `juno`   | Juno Ferrer      |                  |
| `kwame`  | Kwame Osei       |                  |
| `ines`   | Inés Marchetti   |                  |
| `silas`  | Silas Brandt     |                  |
| `noor`   | Noor Haddad      | private account  |
| `ellis`  | Ellis Park       |                  |

Or just sign up — new accounts see a discovery feed until they follow someone.

To start over: `npm run seed -- --reset`.

---

## Going public with TryCloudflare

```bash
./tunnel.sh
```

That builds the web app, starts the server, opens a free quick tunnel and prints the
public URL:

```
  ┌──────────────────────────────────────────────────────────────┐
     Lumen is live

     Public : https://<random-words>.trycloudflare.com
     Local  : http://localhost:4310
  └──────────────────────────────────────────────────────────────┘
```

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `./tunnel.sh`          | Build, serve and tunnel the production app (one origin)     |
| `./tunnel.sh --dev`    | Tunnel the Vite dev server instead, keeping hot reload      |
| `./tunnel.sh --stop`   | Stop the server and the tunnel                              |
| `PORT=4320 ./tunnel.sh`| Use a different local port                                  |

**The tunnel hostname is never written down anywhere.** It changes on every run, and
nothing in the app needs to know it:

- The frontend calls the API with **relative URLs** (`/api/...`) and opens the socket on
  the page's own origin, so whatever host the browser used keeps working.
- In production the API also serves the built frontend, so there is **one origin** and no
  CORS configuration to keep in sync.
- The server sets `trust proxy`, so it reads `X-Forwarded-Proto` from cloudflared and
  marks the session cookie `Secure` over HTTPS and not over plain localhost.
- The Vite dev server sets `allowedHosts: true`, because a quick tunnel's random hostname
  cannot be allow-listed in advance.

Requires `cloudflared` (`brew install cloudflared`).

---

## How it is put together

```
lumen/
├── server/               Express API + Socket.IO (TypeScript, run directly by Node)
│   └── src/
│       ├── index.ts      app wiring, media route, static hosting, error handling
│       ├── schema.sql    the whole database schema
│       ├── db.ts         node:sqlite connection + small query helpers
│       ├── realtime.ts   socket auth, presence, typing
│       ├── seed.ts       demo world
│       ├── lib/          auth, media access, visibility rules, notifications, previews
│       └── routes/       auth · users · posts · feed · stories · explore · messages · collections
├── web/                  React 19 + Vite + Tailwind v4
│   └── src/
│       ├── components/   AppShell, PostCard, Stories, Composer, dialogs …
│       ├── pages/        Feed, Explore, Profile, PostPage, Messages, Settings …
│       └── lib/          api client, auth context, socket, theme, cache helpers
├── scripts/              dev runner · test suites · backup
├── tunnel.sh             build + serve + TryCloudflare
└── data/                 SQLite database and uploaded images (created on first run)
```

**Why this stack.** The interesting problems here are social-graph visibility, media
handling and realtime — not infrastructure. So the boring parts are kept boring:

- **`node:sqlite`** — SQLite is built into Node 22+, so persistence needs no dependency,
  no daemon and no native compile step. WAL mode, foreign keys on, plain SQL.
- **TypeScript with no build step on the server.** Node runs `.ts` files directly via
  type stripping; `npm run typecheck` is the type gate. One less pipeline to maintain.
- **Images on disk, metadata in the database.** Uploads never land in a table.
- **Socket.IO** for the handful of things that must be live, and plain HTTP for
  everything else.

### Media pipeline

Uploads are streamed to a temporary file, re-encoded by **sharp**, and written to
`data/uploads/<shard>/<id>/` as three WebP variants — `thumb` (400² cover), `feed`
(≤1080×1350) and `full` (≤1600) — plus a 16-pixel inline preview stored on the row and
used as a blur-up placeholder while the real file decodes. Originals are discarded, EXIF
orientation is applied and all other metadata is dropped. Media ids carry 16 random
characters, but that is only a second line of defence — see Authorization below for how
image requests are actually checked.

**Video** extends the same pipeline rather than running beside it. A clip is probed with
ffmpeg, rejected if it is not really video or runs past `MAX_VIDEO_SECONDS`, and a poster
frame is extracted and pushed through the identical sharp step — so every video already
owns the three WebP variants the rest of the app renders, and a grid, feed or link
preview needs to know nothing about video at all. The post is created immediately with
`status: 'processing'`; an in-process queue then transcodes to H.264/AAC MP4 with
`-movflags +faststart` and emits `media:ready` over the socket, so the player swaps in
without a reload. `video.mp4` is served through the same `decideMediaAccess` check as
every image, with Range requests answered 206 so seeking works. A transcode that dies
leaves `status: 'failed'` and a poster with an explanatory overlay, never a broken
player; because the queue lives in memory, anything still `processing` at boot is failed
on startup rather than left waiting forever. Reels is a ranked feed over exactly this
data — `kind = 'video' AND status = 'ready'` filtered through the ordinary visibility
predicate — not a second content type.

### Opening a post

Tapping a picture opens the post over whatever you were looking at, rather than
navigating away from it. The post keeps its own URL, so sharing, refreshing and
the back button behave exactly as before — but because the page you came from is
still mounted underneath, the post can have a backdrop to click, a close button
and Escape. A plain route change has none of those, which left the browser's own
back button as the only way out.

Land on `/p/:id` directly and there is no page behind it, so it renders as an
ordinary page with a back control that stays visible at every width.

The media column is sized from the media's own aspect ratio rather than a fixed
fraction of the card, and the card shrinks to those two columns. A fraction
leaves a slab of dead background beside anything portrait — worst for a 9:16
reel, which occupied barely half its column — because the picture letterboxes
inside a frame far wider than it needs. `frameRatio` is shared with the carousel
so the column and the picture cannot disagree.

### Calling

Audio and video are one feature, not two. A video call is the same peer
connection with a camera track attached; the server only learns which kind was
asked for, so the callee's device can open a camera before answering and label
the ring correctly. Everything else — signalling, busy state, blocking,
presence, history — is shared, and an unknown `kind` falls back to audio.

Media is peer-to-peer and never touches the server. Two details are worth
knowing:

- **`Permissions-Policy` must name the devices.** `camera=()` blocks getUserMedia
  on our own origin, not just in frames — the same trap that once disabled the
  microphone. Both are `(self)`.
- **Turning a camera off keeps the RTP flowing** as black frames, so the peer's
  track never reports itself muted. The camera state is announced to the other
  side over the existing signalling relay, and the overlay falls back to the
  avatar on that word rather than on the track flag.

A socket handler that throws would reach the process-level `uncaughtException`
hook, which deliberately exits — so every listener is wrapped, and the call
recorder checks its foreign keys still resolve before writing. Deleting an
account mid-call used to take the whole server down.

### Two-factor authentication

An authenticator app (TOTP, RFC 6238) on top of the password. The algorithm is
implemented on `node:crypto` rather than pulled from a package — it is thirty
lines, and a dependency in the login path is a dependency that can take the
login path down. The one package added is a dependency-free QR encoder, used
server-side so the enrolment image arrives as an inline SVG and the browser
bundle and CSP are untouched.

Details that matter more than the happy path:

- **Enrolment is three steps.** Confirm the password, scan the code, then prove
  the app produces a working code. A secret that was generated but never
  confirmed never gates a login, so a half-finished setup cannot lock anyone out.
- **A code is burned when used.** Each accepted code records its 30-second step
  and that step is refused afterwards, so a code read over someone's shoulder is
  useless a moment later. The visible consequence is that enabling and then
  immediately signing in needs the *next* code.
- **The login challenge is not a session.** A correct password returns a
  short-lived single-use token and nothing else; no cookie is set until a second
  factor is presented.
- **Guesses are budgeted per account, not per challenge** — otherwise starting a
  fresh login would buy a fresh allowance of guesses at six digits.
- **Recovery codes** are stored hashed, shown once, single-use, and can be
  regenerated with the password.
- Turning 2FA on signs out every other device.

### Signed-in devices

`Settings → Security` lists every live session with its device and last use, and
can end any of them individually. The list is keyed by a prefix of the session's
hash, never a usable token.

### Blocking, muting and privacy

Three different things, deliberately kept apart:

**Blocking** is mutual and total. To the person blocked, the account stops
existing: the profile, its posts, its stories and its media all answer 404 with
the same wording used for content that was genuinely deleted, so ids cannot be
probed to learn what is there. The one asymmetry is intentional — the person who
blocked can still open the profile, because otherwise there is nowhere to press
Unblock.

**Muting** changes nothing about permissions. A muted account keeps every bit of
access it had, is never told, and still reaches you through notifications and
direct messages; their posts and stories simply stop appearing in your feed,
Reels and Explore. Search still finds them, because searching for someone by name
is a deliberate act. The rule lives in `UNMUTED_POSTS_SQL`, kept apart from
`VISIBLE_POSTS_SQL` so nothing in the authorization path can ever read it.

**Private accounts** answer 403 rather than 404, and that is the point: the
profile is visible so a stranger can ask to follow.

**Activity status** and **read receipts** are switches, and both are reciprocal:
turn one off and you stop sending that signal *and* stop receiving it, so it
cannot be used to watch without being watched. Both are enforced server-side —
the timestamp does not leave the server rather than being hidden in the UI.
Presence in particular fails closed: `userCard` treats an unfetched setting as
"do not show", so a query that forgets to select it costs a green dot rather
than someone's privacy.

### Authorization

Every read of another person's content goes through one place
(`server/src/lib/visibility.ts`), as either a helper or a SQL predicate that the feed,
explore, search and hashtag queries all share:

- Blocking hides content **in both directions** — profile, posts, search, explore,
  comments, follows and messaging.
- Private accounts are visible only to accepted followers; following one creates a
  pending request the owner can approve or decline.
- Post, comment, story, message and account mutations each re-check ownership on the
  server. Nothing relies on the UI hiding a button.

**Reposting is stricter than reading.** Being allowed to see a post is not the same as
being allowed to hand it to your own followers, so a private account's posts can be
neither reposted nor quoted even by an approved follower. A quote embeds the original,
and that embed is re-checked against the *reader* on every request — if the quoted author
goes private or blocks you, the card becomes "unavailable" rather than leaking. Deleting
the original leaves the quote standing with a tombstone, so the commentary still makes
sense.

**Calls are peer-to-peer.** Media never touches the server: WebRTC carries the audio —
and the video, on a video call — directly between the two browsers, and the existing
authenticated socket only brokers the handshake. That means calling inherits the app's identity, blocking and
presence rules rather than inventing its own — you can call whoever you can message, a
block closes the channel both ways, and an offline or already-busy person is reported
instead of ringing into the void. Live call state is held in memory (a call is
meaningless across a restart); what persists is a `calls` row and a matching entry in the
thread, so history reuses the existing message plumbing for unread counts, realtime
delivery and deletion. Third parties cannot inject signalling, answer, or hang up
someone else's call — every event re-checks that the sender is one of the two
participants.

**Story replies are direct messages.** Reacting or replying to a story requires the same
permission as watching it, so a private account's story cannot be answered by a stranger
and a block closes both directions. A reply lands in the normal inbox carrying the story
as context; stories only last a day, so the message keeps a flag that outlives the story
and the bubble degrades to "replied to a story that has expired" rather than losing its
meaning. Reactions are one per person, changeable, and visible only to the author beside
the viewer list.

**Images are authorized too**, not merely unguessable. `lib/mediaAccess.ts` resolves what
each file is attached to and answers per request: avatars are public, post and story
images follow their author's privacy and block state, and anything sent in a DM is
restricted to the two participants. Unguessable ids remain as a second line, but URLs
leak — through history, referrers, and forwarding — and a follower who is later blocked
would otherwise keep every URL they had already collected. Restricted images are served
`private` so shared caches cannot hold them, and public post images use a one-hour cache
rather than an immutable one so switching an account to private takes effect quickly.

### Accounts and sessions

- Passwords: scrypt with a per-password salt and constant-time comparison, plus a
  rejection list for the handful of passwords that appear in every credential dump.
- Sessions: 256-bit random tokens in an httpOnly, SameSite=Lax cookie (Secure in
  production). Only a SHA-256 digest is stored, so a leaked database copy contains
  nothing replayable. Sessions expire absolutely (30 days) and on idleness (14 days).
- Failed logins are throttled per source *and* per account, counting failures only and
  clearing on success — so guessing is limited even from rotating IPs, while a person who
  knows their password is never locked out by their own earlier typos.
- Changing a password, resetting it, or "sign out everywhere else" revokes other sessions
  immediately; open WebSockets belonging to a revoked session are closed within a minute.
- Deleting an account requires the password again: an unattended session should not be
  enough to destroy someone's data.

### Abuse and denial of service

- Every mutating route has a rate limit, and there is a global per-caller ceiling. Limits
  are keyed on the signed-in user where there is one, and otherwise on the IP.
- `trust proxy` is restricted to the loopback hop and, in production, the server binds to
  `127.0.0.1` so cloudflared is the only way in. Together these are what make the
  forwarded client IP trustworthy — with `trust proxy: true`, any client could set
  `X-Forwarded-For` and walk past every IP-based limit.
- Uploads are capped by size, count, dimensions **and megapixels**, so a 300 KB
  decompression bomb cannot expand into hundreds of megabytes of RAM. Image processing
  runs behind a concurrency gate, so a burst of uploads queues rather than exhausting
  memory.
- WebSocket clients get a per-socket event budget and a per-account connection cap.

### Browser-side protections

- A strict Content-Security-Policy with no `unsafe-inline` in `script-src` (the one inline
  script is allowed by hash), `frame-ancestors 'none'`, and `object-src 'none'`.
- State-changing requests are rejected unless the `Origin` matches the request's own host
  — a server-side CSRF check that works alongside SameSite and needs no configuration when
  the tunnel hostname changes.
- All user text is rendered by React as text nodes; the app contains no
  `dangerouslySetInnerHTML`, and profile links reject non-http schemes.

---

## Everyday commands

| Command                     | What it does                                              |
| --------------------------- | --------------------------------------------------------- |
| `npm run dev`               | API on :4310 and Vite on :5190, output prefixed per process |
| `npm run build`             | Build the web app into `web/dist`                           |
| `npm run serve`             | Build, then serve everything from the API on :4310          |
| `npm run seed`              | Seed demo data (`-- --reset` to wipe first)                 |
| `npm run typecheck`         | Typecheck server and web                                    |
| `npm test`                  | Functional end-to-end API suite                             |
| `npm run test:security`     | Security and abuse regression suite                         |
| `npm run test:2fa`          | Two-factor, signed-in devices and the privacy switches      |
| `npm run test:2fa:ui`       | Enrolling and signing in with 2FA through the real UI       |
| `npm run test:calls`        | Call lifecycle and signalling suite                         |
| `npm run test:calls:edge`   | Call exits, malformed signalling, video call protocol       |
| `npm run test:calls:video`  | A real video call between two Chrome instances              |
| `npm run test:social`       | Reposts, collections, comments, mentions, previews          |
| `npm run test:video`        | Video upload, transcoding, Reels, playback and cleanup      |
| `npm run test:mute`         | Mute: feeds quieten, permissions do not change              |
| `npm run test:regression`   | Blocking, deletion, pagination, validation and authorization |
| `npm run test:ui`           | Every route in real Chrome, empty and populated             |
| `npm run test:ui:sweep`     | Six widths, both themes: overlap, overflow, a11y, tap size  |
| `npm run test:ui:flows`     | Story viewer, composer, search, comments, keyboard          |
| `npm run test:features-ui`  | Renaming and muting through the real Settings UI            |
| `npm run test:post-overlay` | Opening a post, and every way of closing it again           |
| `npm run test:post-layout`  | The opened post fits its media, at every aspect ratio       |
| `npm run backup`            | Snapshot the database and images                            |

**Functional suite** (`scripts/smoke.js`) drives the real HTTP surface — signup, uploads,
likes, comments, stories, messaging, private accounts, blocking, reports, password
changes — and asserts the authorization rules from both sides of each boundary.

**Social suite** (`scripts/social-test.js`) covers reposts, quote reposts, bookmark
collections, threaded comments, mention autocomplete, link previews and story
replies/reactions, including the privacy edges: a private account's post cannot be repeated, a blocked viewer loses the
embedded quote, and a private caption never reaches an Open Graph tag. Run it alongside
the functional suite with limits off:

```bash
npm run test:social
```

Rate limits will stop it part way through, because it creates several accounts from one
address. Run the server with limits off for that suite:

```bash
DISABLE_RATE_LIMITS=1 npm start        # development only; ignored in production
npm test                               # defaults to http://localhost:4310
npm test https://xyz.trycloudflare.com
```

**Security suite** (`scripts/security-test.js`) must run against a server with limits
**on** — the default — because verifying them is part of its job. Each check corresponds
to a specific weakness that was found and fixed: media authorization, decompression
bombs, token storage, session revocation, CSRF, brute-force throttling under IP spoofing,
IDOR, injection, concurrency and deletion of the underlying files.

```bash
npm start
npm run test:security
```

Both suites create their own throwaway accounts and delete them at the end, so they are
safe to run against a seeded database.

## Backups

```bash
npm run backup                       # → data/backups/<timestamp>/
node scripts/backup.js /mnt/backups --keep 14
```

The database snapshot is taken with `VACUUM INTO`, which holds only a read lock, so this
is safe while the server is serving; media files are immutable once written, so copying
them cannot catch a half-written file. Old snapshots rotate automatically.

To restore: stop the server, copy `lumen.db` back to `data/` (delete any leftover
`lumen.db-wal` and `lumen.db-shm` beside it), restore `data/uploads`, and start again.
Run a restore drill before you rely on it.

## Before you launch

1. `NODE_ENV=production` — turns on Secure cookies and HSTS, and binds to loopback so the
   tunnel is the only ingress. `./tunnel.sh` already sets it.
2. **Set `SMTP_URL`.** Without a mail transport, password resets are written to the server
   log and someone has to relay them by hand; a real user who forgets their password is
   locked out. See `.env.example`.
3. Put a backup on a schedule and test a restore.
4. Run the server under something that restarts it — `launchd`, `systemd`, `pm2`. The
   process handles SIGTERM cleanly and checkpoints the database on the way out.
5. Read the startup warnings. The server prints a line for every production setting that
   is unsafe or missing.
6. Take a look at `data/` permissions if the machine has other users on it; the database
   and uploads are readable by the account that runs the server.

---

## Configuration

Everything has a working default; there is no required `.env`.

Everything is read from the environment, and `server/.env` is loaded if present. See
`.env.example` for the annotated list; the ones that matter most:

| Variable      | Default                          | Purpose                                    |
| ------------- | -------------------------------- | ------------------------------------------ |
| `NODE_ENV`    | `development`                    | `production` enables the hardened defaults  |
| `PORT`        | `4310`                           | API port                                    |
| `HOST`        | `127.0.0.1` in prod, else `0.0.0.0` | Bind address                             |
| `TRUST_PROXY` | `loopback`                       | Whose `X-Forwarded-For` to believe          |
| `DATA_DIR`    | `./data`                         | Database and uploads                        |
| `SMTP_URL`    | unset                            | Mail transport for password resets          |
| `LOG_LEVEL`   | `info` in prod, else `debug`     | `debug` \| `info` \| `warn` \| `error`      |

**Password resets.** With `SMTP_URL` set, the link is emailed. Without it, the link is
written to the server log for an operator to relay — it is never returned in the HTTP
response, and the response is identical whether or not the address has an account, so the
endpoint cannot be used to take over an account or to enumerate users.

**Logging.** Production logs are JSON lines. Passwords, tokens and cookies are redacted by
key, and a 500 gives the user only a short reference id that matches the log entry.

---

## Deliberate limits

- **Video is transcoded in-process.** One clip at a time by default
  (`VIDEO_CONCURRENCY`), so simultaneous uploads queue rather than run in parallel.
  That is the point where a separate worker would start to earn its keep.
- **One-to-one messages.** The schema has a members table, so group threads are a UI
  problem rather than a migration, but they are not built.
- **Reports are recorded, not triaged.** They land in the `reports` table; there is no
  moderator interface.
- **Single process.** Sockets are held in memory, so running several instances would
  need a shared adapter. One process handles far more than this app will see.
