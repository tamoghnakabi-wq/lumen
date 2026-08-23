export type UserCard = {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  isPrivate: boolean;
  isOnline: boolean;
};

export type Relation = {
  isSelf: boolean;
  isFollowing: boolean;
  isRequested: boolean;
  followsYou: boolean;
  isBlocked: boolean;
  blockedYou: boolean;
  isMuted: boolean;
};

export type Profile = UserCard & {
  bio: string;
  website: string;
  createdAt: number;
  email?: string;
  /** Only present on your own profile. */
  showActivity?: boolean;
  readReceipts?: boolean;
  counts: { posts: number; followers: number; following: number };
  relation: Relation;
  canViewPosts: boolean;
};

export type Media = {
  id: string;
  /** Videos carry a poster at the same three image URLs, plus a playable file. */
  kind: "image" | "video";
  status: "ready" | "processing" | "failed";
  width: number;
  height: number;
  preview: string | null;
  url: string;
  thumb: string;
  full: string;
  video: string | null;
  durationMs: number;
  hasAudio: boolean;
};

export type Post = {
  id: string;
  caption: string;
  location: string;
  createdAt: number;
  editedAt: number | null;
  author: UserCard;
  media: Media[];
  hashtags: string[];
  counts: { likes: number; comments: number; saves: number; reposts: number; quotes: number };
  viewer: {
    liked: boolean;
    saved: boolean;
    reposted: boolean;
    isAuthor: boolean;
    followsAuthor: boolean;
    requestedAuthor: boolean;
    isMuted: boolean;
  };
  /** Set when this post quotes another; null when the original is gone or hidden. */
  quotedPost: Post | null;
  quotedUnavailable: boolean;
  /** Present in the feed when the post arrived because someone reposted it. */
  repostedBy?: { id: string; username: string; displayName: string; avatar: string | null; isSelf: boolean };
};

export type Comment = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  createdAt: number;
  author: UserCard;
  counts: { likes: number; replies: number };
  viewer: { liked: boolean };
};

export type CommentSort = "top" | "new";

export type Collection = {
  id: string;
  name: string;
  createdAt: number;
  count: number;
  cover: string | null;
};

export type MentionSuggestion = UserCard & { connected: boolean };

export type Story = {
  id: string;
  caption: string;
  createdAt: number;
  expiresAt: number;
  seen: boolean;
  /** The viewer's own quick reaction, if they left one. */
  myReaction: string | null;
  reactionCount: number;
  media: Media;
};

export type StoryGroup = {
  author: UserCard;
  stories: Story[];
  isSelf: boolean;
  hasUnseen: boolean;
  latestAt: number;
};

export type NotificationType =
  | "like"
  | "comment"
  | "comment_like"
  | "follow"
  | "follow_request"
  | "follow_accepted"
  | "mention"
  | "repost"
  | "quote"
  | "story_reaction";

export type Notification = {
  id: string;
  type: NotificationType;
  createdAt: number;
  read: boolean;
  actor: UserCard;
  postId: string | null;
  commentId: string | null;
  commentBody: string | null;
  postThumb: string | null;
};

export type Conversation = {
  id: string;
  lastMessageAt: number;
  unread: number;
  theirLastReadAt: number;
  partner: UserCard | null;
  blocked: boolean;
  lastMessage: {
    id: string;
    body: string;
    hasMedia: boolean;
    hasPost: boolean;
    hasCall: boolean;
    createdAt: number;
    mine: boolean;
  } | null;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: number;
  deleted: boolean;
  media: Media | null;
  sharedPost: Post | null;
  /** Present when this message replied to a story that has not expired yet. */
  story: { id: string; authorId: string; caption: string; thumb: string; mine: boolean } | null;
  isStoryReply: boolean;
  /** Present on the thread entry a finished audio call leaves behind. */
  call: { id: string; status: string; kind: "audio" | "video"; outgoing: boolean; durationMs: number } | null;
  mine: boolean;
};

export type SearchResults = {
  users: (UserCard & { bio: string; isFollowing: boolean })[];
  tags: { tag: string; posts: number }[];
  posts: Post[];
};

export type Suggestion = UserCard & { bio: string; mutuals: number };

export type TwoFactorState = {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
};

export type TwoFactorEnrolment = {
  secret: string;
  uri: string;
  /** Inline SVG data URI, rendered by the server so no QR library ships to the browser. */
  qr: string;
};

export type SessionSummary = {
  id: string;
  current: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  device: string;
};
