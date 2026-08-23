import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Clapperboard,
  Compass,
  Home,
  MessageCircle,
  PlusSquare,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useAuth } from "../lib/auth.tsx";
import { useComposer } from "../lib/ui.tsx";
import { useBadges } from "../hooks/useBadges.ts";
import { Avatar } from "./Avatar.tsx";
import { Wordmark } from "./Wordmark.tsx";

type NavEntry = {
  to: string;
  label: string;
  icon: typeof Home;
  badge?: number;
  end?: boolean;
};

export function AppShell() {
  const { user } = useAuth();
  const { openPostComposer } = useComposer();
  const badges = useBadges();
  const location = useLocation();
  const navigate = useNavigate();

  if (!user) return null;

  const entries: NavEntry[] = [
    { to: "/", label: "Home", icon: Home, end: true },
    { to: "/explore", label: "Explore", icon: Compass },
    { to: "/reels", label: "Reels", icon: Clapperboard },
    { to: "/messages", label: "Messages", icon: MessageCircle, badge: badges.messages },
    { to: "/notifications", label: "Notifications", icon: Bell, badge: badges.notifications },
  ];

  // The thread view owns the whole screen on mobile.
  const hideMobileChrome = /^\/messages\/[^/]+$/.test(location.pathname);
  // Reels keeps the tab bar so you can leave, but drops the top bar: the video
  // runs edge to edge and its own overlay carries the controls.
  const hideMobileHeader = hideMobileChrome || location.pathname === "/reels";

  return (
    <div className="min-h-dvh bg-bg">
      {/* ---------------------------------------------------- desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[76px] flex-col border-r border-line bg-surface/70 px-3 py-5 backdrop-blur md:flex xl:w-[236px] xl:px-4">
        <div className="mb-7 px-1.5 xl:px-2">
          <NavLink to="/" aria-label="Lumen home">
            <Wordmark compact className="xl:hidden" />
            <Wordmark className="hidden xl:flex" />
          </NavLink>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {entries.map((entry) => (
            <RailLink key={entry.to} entry={entry} />
          ))}
          <button
            onClick={openPostComposer}
            className="group flex items-center gap-3.5 rounded-xl px-3 py-2.5 text-muted transition hover:bg-raised hover:text-fg"
          >
            <PlusSquare size={23} strokeWidth={1.9} />
            <span className="hidden text-[15px] xl:inline">Create</span>
          </button>
          <NavLink
            to={`/${user.username}`}
            className={({ isActive }) =>
              `group flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition hover:bg-raised ${
                isActive ? "font-semibold text-fg" : "text-muted hover:text-fg"
              }`
            }
          >
            <Avatar user={user} size={23} link={false} />
            <span className="hidden text-[15px] xl:inline">Profile</span>
          </NavLink>
        </nav>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition hover:bg-raised ${
              isActive ? "font-semibold text-fg" : "text-muted hover:text-fg"
            }`
          }
        >
          <Settings size={23} strokeWidth={1.9} />
          <span className="hidden text-[15px] xl:inline">Settings</span>
        </NavLink>
      </aside>

      {/* ------------------------------------------------------- mobile top */}
      {!hideMobileHeader && (
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-2.5 backdrop-blur-md md:hidden">
          <NavLink to="/" aria-label="Lumen home">
            <Wordmark />
          </NavLink>
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigate("/explore?focus=1")}
              className="press rounded-full p-2 text-fg"
              aria-label="Search"
            >
              <Search size={22} strokeWidth={1.9} />
            </button>
            <IconLink to="/notifications" label="Notifications" badge={badges.notifications}>
              <Bell size={22} strokeWidth={1.9} />
            </IconLink>
            <IconLink to="/messages" label="Messages" badge={badges.messages}>
              <MessageCircle size={22} strokeWidth={1.9} />
            </IconLink>
          </div>
        </header>
      )}

      {/* ------------------------------------------------------------ main */}
      <main
        className={`md:pl-[76px] xl:pl-[236px] ${hideMobileChrome ? "" : "pb-[var(--tabbar-h)] md:pb-0"}`}
      >
        <Outlet />
      </main>

      {/* ---------------------------------------------------- mobile tabbar */}
      {!hideMobileChrome && (
        <nav className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--tabbar-h)] items-center justify-around border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
          <TabLink to="/" label="Home" end>
            <Home size={23} strokeWidth={1.9} />
          </TabLink>
          <TabLink to="/explore" label="Explore">
            <Compass size={23} strokeWidth={1.9} />
          </TabLink>
          <button
            onClick={openPostComposer}
            aria-label="Create post"
            className="press flex flex-col items-center px-4 py-2.5 text-fg"
          >
            <SquarePen size={23} strokeWidth={1.9} />
          </button>
          <TabLink to="/reels" label="Reels">
            <Clapperboard size={23} strokeWidth={1.9} />
          </TabLink>
          <NavLink
            to={`/${user.username}`}
            aria-label="Profile"
            className={({ isActive }) => `flex flex-col items-center px-4 py-2.5 ${isActive ? "opacity-100" : "opacity-65"}`}
          >
            <Avatar user={user} size={23} link={false} />
          </NavLink>
        </nav>
      )}
    </div>
  );
}

function RailLink({ entry }: { entry: NavEntry }) {
  const Icon = entry.icon;
  return (
    <NavLink
      to={entry.to}
      end={entry.end}
      className={({ isActive }) =>
        `group relative flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition hover:bg-raised ${
          isActive ? "font-semibold text-fg" : "text-muted hover:text-fg"
        }`
      }
    >
      <span className="relative">
        <Icon size={23} strokeWidth={1.9} />
        {!!entry.badge && (
          <span className="absolute -right-1.5 -top-1 min-w-[15px] rounded-full bg-danger px-1 text-[10px] font-bold leading-[15px] text-white">
            {entry.badge > 9 ? "9+" : entry.badge}
          </span>
        )}
      </span>
      <span className="hidden text-[15px] xl:inline">{entry.label}</span>
    </NavLink>
  );
}

function IconLink({
  to,
  label,
  badge,
  children,
}: {
  to: string;
  label: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <NavLink to={to} aria-label={label} className="press relative rounded-full p-2 text-fg">
      {children}
      {!!badge && (
        <span className="absolute right-0.5 top-0.5 min-w-[15px] rounded-full bg-danger px-1 text-[10px] font-bold leading-[15px] text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </NavLink>
  );
}

function TabLink({
  to,
  label,
  end,
  children,
}: {
  to: string;
  label: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      className={({ isActive }) => `flex flex-col items-center px-4 py-2.5 transition ${isActive ? "text-fg" : "text-muted"}`}
    >
      {children}
    </NavLink>
  );
}
