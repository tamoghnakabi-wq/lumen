/**
 * Seeds a demo world: eight accounts with avatars, posts, stories, follows,
 * likes, comments, saved posts and a couple of conversations.
 *
 *   npm run seed            add demo data if the database is empty
 *   npm run seed -- --reset wipe everything first
 */
import fs from "node:fs/promises";
import { all, db, get, run } from "./db.ts";
import { uploadsDir } from "./config.ts";
import { config } from "./config.ts";
import { hashPassword } from "./lib/auth.ts";
import { newId } from "./lib/ids.ts";
import { storeImage } from "./lib/media.ts";
import { artworkSvg, avatarSvg } from "./lib/artwork.ts";
import { extractHashtags } from "./lib/text.ts";

const PASSWORD = "lumen123";

type Person = { username: string; name: string; bio: string; website?: string; private?: boolean };

const PEOPLE: Person[] = [
  { username: "mara", name: "Mara Voss", bio: "Photographer chasing light in cold places.\nPrints in bio.", website: "maravoss.studio" },
  { username: "theo", name: "Theo Lin", bio: "Architecture, concrete and long shadows." },
  { username: "juno", name: "Juno Ferrer", bio: "Sea swimmer. Film only. Salt in everything." },
  { username: "kwame", name: "Kwame Osei", bio: "Street portraits + city nights 🌃", website: "kwame.photo" },
  { username: "ines", name: "Inés Marchetti", bio: "Botanical studies and slow mornings." },
  { username: "silas", name: "Silas Brandt", bio: "Desert roads, 35mm, no plans." },
  { username: "noor", name: "Noor Haddad", bio: "Quiet corners of loud cities.", private: true },
  { username: "ellis", name: "Ellis Park", bio: "Colour theory enthusiast. Mostly clouds." },
];

const CAPTIONS = [
  "First light over the ridge. Waited two hours in the cold for this one. #sunrise #landscape",
  "Concrete and sky. There's a rhythm to this block that I keep coming back to. #architecture #brutalism",
  "The water was 9°C and absolutely worth it. #coldwater #swim #film",
  "Late shift on the avenue. Everyone going somewhere. #streetphotography #night",
  "Three weeks of growth in one frame. Patience is a medium. #botanical #stilllife",
  "Ran out of road before I ran out of daylight. #desert #roadtrip",
  "A corner I walk past every day, finally seen properly. #city #quiet",
  "Cloud study no. 14. I could do these forever. #clouds #colour",
  "Tide coming in fast. Shot this and then ran. #ocean #coast",
  "Golden hour did most of the work here honestly. #goldenhour #portrait",
  "Found this stairwell by accident. Stayed forty minutes. #architecture #lines",
  "Morning fog burning off the valley. #fog #landscape #sunrise",
  "Testing a new roll. Grain is doing something lovely here. #film #35mm",
  "The market at closing time — my favourite hour. #streetphotography #city",
  "Everything in this frame is the same colour except one thing. #colour #minimal",
  "Left the tripod at home and regretted nothing. #handheld #night",
  "Second attempt at this composition. Still not right, still posting it. #process",
  "Sun through the leaves, twenty seconds before it was gone. #botanical #light",
  "Cold morning, warm coffee, decent frame. #morning #film",
  "This wall has been repainted four times since I started shooting it. #texture #city",
];

const COMMENTS = [
  "This is stunning 😍",
  "the light here, wow",
  "Okay this is my new wallpaper",
  "How did you get the colours this clean?",
  "Absolutely love this one",
  "That composition is doing a lot of work",
  "Been waiting for you to post again",
  "Where is this?? Need to go",
  "The grain is perfect",
  "Beautiful frame 👏",
  "This one stopped my scroll",
  "so good",
];

const STORY_CAPTIONS = ["Out early", "Testing a roll", "Rooftop hour", "Last of the light", "Studio day", ""];

function pick<T>(list: T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function resetAll() {
  const tables = [
    "reports", "notifications", "messages", "conversation_members", "conversations",
    "story_views", "stories", "comment_likes", "comments", "saves", "likes",
    "post_hashtags", "post_media", "posts", "blocks", "follows",
    "password_resets", "sessions", "media", "users",
  ];
  db.exec("PRAGMA foreign_keys = OFF");
  for (const t of tables) run(`DELETE FROM ${t}`);
  db.exec("PRAGMA foreign_keys = ON");
  await fs.rm(uploadsDir, { recursive: true, force: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  console.log("  cleared existing data");
}

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset) await resetAll();

  const existing = get<{ c: number }>("SELECT COUNT(*) AS c FROM users")!;
  if (existing.c > 0) {
    console.log(`Database already has ${existing.c} users. Use "npm run seed -- --reset" to start over.`);
    return;
  }

  console.log("Seeding Lumen…");
  const rand = mulberry32(20260813);
  const passwordHash = await hashPassword(PASSWORD);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // --- accounts -----------------------------------------------------------
  const users: { id: string; username: string }[] = [];
  for (const [i, person] of PEOPLE.entries()) {
    const id = newId();
    const createdAt = now - (60 - i * 4) * day;
    run(
      `INSERT INTO users (id, username, email, password_hash, display_name, bio, website, is_private, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      person.username,
      `${person.username}@lumen.test`,
      passwordHash,
      person.name,
      person.bio,
      person.website ?? "",
      person.private ? 1 : 0,
      createdAt,
      now - Math.floor(rand() * 3 * day),
    );
    const initials = person.name.split(" ").map((p) => p[0]).join("").slice(0, 2);
    const avatar = await storeImage(Buffer.from(avatarSvg(i * 37 + 5, initials)), id);
    run("UPDATE users SET avatar_id = ? WHERE id = ?", avatar.id, id);
    users.push({ id, username: person.username });
    process.stdout.write(`  @${person.username}`);
  }
  console.log("\n  8 accounts created");

  // --- follows ------------------------------------------------------------
  let followCount = 0;
  for (const a of users) {
    for (const b of users) {
      if (a.id === b.id) continue;
      if (rand() > 0.45) continue;
      const target = PEOPLE.find((p) => p.username === b.username)!;
      const status = target.private ? (rand() > 0.5 ? "accepted" : "pending") : "accepted";
      run(
        "INSERT OR IGNORE INTO follows (follower_id, following_id, status, created_at) VALUES (?,?,?,?)",
        a.id,
        b.id,
        status,
        now - Math.floor(rand() * 40 * day),
      );
      followCount++;
    }
  }
  console.log(`  ${followCount} follow edges`);

  // --- posts --------------------------------------------------------------
  const postIds: { id: string; authorId: string; createdAt: number }[] = [];
  for (let i = 0; i < 28; i++) {
    const author = users[Math.floor(rand() * users.length)];
    const caption = CAPTIONS[i % CAPTIONS.length];
    const createdAt = now - Math.floor(rand() * 21 * day) - Math.floor(rand() * 60 * 60 * 1000);
    const id = newId();
    run(
      "INSERT INTO posts (id, author_id, caption, location, created_at) VALUES (?,?,?,?,?)",
      id,
      author.id,
      caption,
      rand() > 0.6 ? pick(["Reykjavík", "Lisbon", "Kyoto", "Marseille", "Oaxaca", "Trieste", "Tallinn"], rand) : "",
      createdAt,
    );
    const imageCount = rand() > 0.7 ? 2 + Math.floor(rand() * 2) : 1;
    for (let n = 0; n < imageCount; n++) {
      const media = await storeImage(Buffer.from(artworkSvg(i * 101 + n * 17 + 3, 1200, rand() > 0.5 ? 1500 : 1200)), author.id);
      run("INSERT INTO post_media (post_id, media_id, position) VALUES (?,?,?)", id, media.id, n);
    }
    for (const tag of extractHashtags(caption)) {
      run("INSERT OR IGNORE INTO post_hashtags (post_id, tag) VALUES (?,?)", id, tag);
    }
    postIds.push({ id, authorId: author.id, createdAt });
    process.stdout.write(".");
  }
  console.log(`\n  ${postIds.length} posts`);

  // --- engagement ---------------------------------------------------------
  let likes = 0;
  let comments = 0;
  for (const post of postIds) {
    for (const user of users) {
      if (user.id === post.authorId || rand() > 0.55) continue;
      run(
        "INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?,?,?)",
        user.id,
        post.id,
        post.createdAt + Math.floor(rand() * day),
      );
      likes++;
      if (rand() > 0.75) {
        const commentId = newId();
        run(
          "INSERT INTO comments (id, post_id, author_id, parent_id, body, created_at) VALUES (?,?,?,?,?,?)",
          commentId,
          post.id,
          user.id,
          null,
          pick(COMMENTS, rand),
          post.createdAt + Math.floor(rand() * day),
        );
        comments++;
        run(
          "INSERT INTO notifications (id, user_id, actor_id, type, post_id, comment_id, created_at, read_at) VALUES (?,?,?,?,?,?,?,?)",
          newId(),
          post.authorId,
          user.id,
          "comment",
          post.id,
          commentId,
          post.createdAt + Math.floor(rand() * day),
          rand() > 0.4 ? now : null,
        );
      } else {
        run(
          "INSERT INTO notifications (id, user_id, actor_id, type, post_id, created_at, read_at) VALUES (?,?,?,?,?,?,?)",
          newId(),
          post.authorId,
          user.id,
          "like",
          post.id,
          post.createdAt + Math.floor(rand() * day),
          rand() > 0.35 ? now : null,
        );
      }
      if (rand() > 0.85) {
        run(
          "INSERT OR IGNORE INTO saves (user_id, post_id, created_at) VALUES (?,?,?)",
          user.id,
          post.id,
          now - Math.floor(rand() * 10 * day),
        );
      }
    }
  }
  console.log(`  ${likes} likes, ${comments} comments`);

  // --- stories ------------------------------------------------------------
  let stories = 0;
  for (const user of users) {
    if (rand() > 0.7) continue;
    const count = 1 + Math.floor(rand() * 2);
    for (let n = 0; n < count; n++) {
      const createdAt = now - Math.floor(rand() * 18 * 60 * 60 * 1000);
      const media = await storeImage(Buffer.from(artworkSvg(stories * 313 + 77, 1080, 1920)), user.id);
      run(
        "INSERT INTO stories (id, author_id, media_id, caption, created_at, expires_at) VALUES (?,?,?,?,?,?)",
        newId(),
        user.id,
        media.id,
        pick(STORY_CAPTIONS, rand),
        createdAt,
        createdAt + config.storyTtlMs,
      );
      stories++;
    }
  }
  console.log(`  ${stories} live stories`);

  // --- conversations ------------------------------------------------------
  const chats: [string, string, string[]][] = [
    ["mara", "theo", [
      "That stairwell shot — where was it?",
      "Old library annexe, second entrance. Go before 10am, the light does the thing.",
      "Perfect. Going Saturday.",
    ]],
    ["juno", "silas", [
      "Roll came back. Two frames usable, both yours.",
      "ha! Which two?",
      "The one with the tide and the one where you're out of focus. Obviously.",
    ]],
    ["kwame", "ellis", [
      "Your cloud series is unreal",
      "thank you!! it's mostly just standing outside a lot",
    ]],
  ];
  for (const [aName, bName, lines] of chats) {
    const a = users.find((u) => u.username === aName)!;
    const b = users.find((u) => u.username === bName)!;
    const convId = newId();
    const start = now - Math.floor(rand() * 3 * day);
    run("INSERT INTO conversations (id, created_at, last_message_at) VALUES (?,?,?)", convId, start, start);
    run("INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?,?,?)", convId, a.id, 0);
    run("INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?,?,?)", convId, b.id, 0);
    let at = start;
    lines.forEach((line, i) => {
      at += 4 * 60 * 1000 + Math.floor(rand() * 20 * 60 * 1000);
      run(
        "INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?,?,?,?,?)",
        newId(),
        convId,
        i % 2 === 0 ? a.id : b.id,
        line,
        at,
      );
    });
    run("UPDATE conversations SET last_message_at = ? WHERE id = ?", at, convId);
  }
  console.log(`  ${chats.length} conversations`);

  const mediaCount = all("SELECT id FROM media").length;
  console.log(`\nDone. ${mediaCount} images written to ${uploadsDir}`);
  console.log(`\nSign in with any of these — password: ${PASSWORD}`);
  for (const p of PEOPLE) console.log(`  ${p.username.padEnd(8)} ${p.name}${p.private ? "  (private account)" : ""}`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
