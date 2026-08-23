-- Lumen schema. All timestamps are integer milliseconds since epoch.
-- Booleans are stored as 0/1 integers.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,          -- stored lowercase, [a-z0-9._]
  -- NOTE: on a database that predates this column the CREATE TABLE above is a
  -- no-op, so the 2026-08-22-username-changes migration adds it as well.
  username_changed_at INTEGER NOT NULL DEFAULT 0,
  -- Privacy switches. Both are reciprocal: turn one off and you stop sending
  -- that signal AND stop receiving it, so it cannot be used one-sidedly.
  -- (Added by the 2026-08-23-privacy-controls migration on existing databases.)
  show_activity  INTEGER NOT NULL DEFAULT 1,
  read_receipts  INTEGER NOT NULL DEFAULT 1,
  email          TEXT NOT NULL UNIQUE,          -- stored lowercase
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '',
  bio            TEXT NOT NULL DEFAULT '',
  website        TEXT NOT NULL DEFAULT '',
  avatar_id      TEXT REFERENCES media(id) ON DELETE SET NULL,
  is_private     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL DEFAULT 0
);

-- Only the SHA-256 of a session token is stored: a stolen database copy then
-- contains no usable credentials.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0,
  user_agent    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

-- Two-factor authentication. The secret is only usable alongside the password,
-- so it lives beside it rather than in the users row: `confirmed_at` is null
-- until the first correct code proves the phone was actually enrolled, and an
-- unconfirmed row must never gate a login.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  -- The last step consumed, so a code cannot be replayed inside its 30 seconds.
  last_step    INTEGER NOT NULL DEFAULT 0
);

-- One-time codes for when the authenticator is lost. Hashed, like any credential.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

-- A login that passed the password but still owes a second factor. Short-lived
-- and single-use; it is not a session and grants nothing on its own.
CREATE TABLE IF NOT EXISTS totp_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_totp_challenges_expiry ON totp_challenges(expires_at);

-- Uploaded images. Bytes live on disk under DATA_DIR/uploads; the row is metadata only.
-- Images and videos share one table, one id space and one authorized route.
-- kind:   image | video
-- status: ready | processing | failed   (images are always ready; a video is
--         playable only once its transcode finishes)
CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'image',
  status      TEXT NOT NULL DEFAULT 'ready',
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  has_audio   INTEGER NOT NULL DEFAULT 0,
  preview     TEXT NOT NULL DEFAULT '',         -- tiny inline base64 webp used as a blur placeholder
  created_at  INTEGER NOT NULL
);
-- NOTE: the index on `status` is created by the migration, not here. On a
-- database that predates the column, CREATE TABLE IF NOT EXISTS above is a
-- no-op and this file would be indexing a column that does not exist yet.
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);

-- A quote repost is an ordinary post that points at another one, so it keeps its
-- own caption, hashtags, likes and comments. ON DELETE SET NULL means the quote
-- survives the original being deleted and renders as "post unavailable".
CREATE TABLE IF NOT EXISTS posts (
  id              TEXT PRIMARY KEY,
  author_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption         TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  quoted_post_id  TEXT REFERENCES posts(id) ON DELETE SET NULL,
  -- Deleting the original nulls quoted_post_id, which would otherwise leave the
  -- quote looking like an ordinary post with a dangling caption. This flag
  -- survives, so the card can still say the quoted post is gone.
  is_quote        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER
);
-- NOTE: the index on quoted_post_id is created by the migration, not here.
-- On a database that predates the column, CREATE TABLE IF NOT EXISTS is a no-op
-- and this file would be indexing a column that does not exist yet.
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS post_media (
  post_id   TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id  TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (post_id, position)
);

CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,                        -- lowercase, no leading '#'
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON post_hashtags(tag);

CREATE TABLE IF NOT EXISTS likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS saves (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_saves_user ON saves(user_id, created_at DESC);

-- A plain repost is an action on someone else's post, not a post of its own —
-- so it is shaped like a like rather than like a row in `posts`.
CREATE TABLE IF NOT EXISTS reposts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_user ON reposts(user_id, created_at DESC);

-- Named groups of saved posts. Membership implies the post is also in `saves`,
-- which stays the single source of truth for "have I bookmarked this".
CREATE TABLE IF NOT EXISTS collections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_items_post ON collection_items(post_id);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS comment_likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

-- status: 'accepted' | 'pending' (pending only exists for private targets)
CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'accepted',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- Muting is a feed preference, not a permission: a muted account keeps every bit
-- of access it had and is never told. Kept apart from `blocks` for exactly that
-- reason — nothing in the authorization path may ever read this table.
CREATE TABLE IF NOT EXISTS mutes (
  muter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);
CREATE INDEX IF NOT EXISTS idx_mutes_muted ON mutes(muted_id);

CREATE TABLE IF NOT EXISTS stories (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  caption    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories(expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id  TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);

-- One quick reaction per person per story, changeable and removable. Only the
-- story's author ever sees these, alongside the viewer list.
CREATE TABLE IF NOT EXISTS story_reactions (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_reactions_story ON story_reactions(story_id);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL DEFAULT '',
  media_id        TEXT REFERENCES media(id) ON DELETE SET NULL,
  shared_post_id  TEXT REFERENCES posts(id) ON DELETE SET NULL,
  -- A reply to a story is an ordinary message carrying the story as context.
  -- Stories are purged after 24 hours, which nulls story_id; is_story_reply
  -- survives so the bubble can still say what it was replying to.
  story_id        TEXT REFERENCES stories(id) ON DELETE SET NULL,
  is_story_reply  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id);
CREATE INDEX IF NOT EXISTS idx_post_media_media ON post_media(media_id);
CREATE INDEX IF NOT EXISTS idx_stories_media ON stories(media_id);

-- One row per audio call attempt, kept as history. Live call state is held in
-- memory by the realtime layer; this is the durable record the thread renders.
-- status: completed | missed | declined | cancelled | failed
CREATE TABLE IF NOT EXISTS calls (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  -- NOTE: on a database that predates this column the CREATE TABLE above is a
  -- no-op, so the 2026-08-22-video-calls migration adds it as well.
  kind            TEXT NOT NULL DEFAULT 'audio',   -- 'audio' | 'video'
  started_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  ended_at        INTEGER,
  end_reason      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_calls_conversation ON calls(conversation_id, started_at DESC);

-- type: like | comment | follow | follow_request | follow_accepted | mention | comment_like | story_view
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  post_id    TEXT REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
-- Notifications are paged by id, so the cursor needs its own index.
CREATE INDEX IF NOT EXISTS idx_notifications_page ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_actor ON notifications(actor_id);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                    -- 'post' | 'user' | 'comment'
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
