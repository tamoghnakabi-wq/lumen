import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";
import { useAuth } from "./lib/auth.tsx";
import { CallProvider } from "./lib/call.tsx";
import { UIProvider } from "./lib/ui.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { CallOverlay } from "./components/CallOverlay.tsx";
import { PostDialog } from "./components/PostDialog.tsx";
import { FullPageSpinner } from "./components/States.tsx";
import { AuthPage, ResetPasswordPage } from "./pages/Auth.tsx";
import { ExplorePage } from "./pages/Explore.tsx";
import { FeedPage } from "./pages/Feed.tsx";
import { MessagesPage } from "./pages/Messages.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";
import { NotificationsPage } from "./pages/Notifications.tsx";
import { PostPage } from "./pages/PostPage.tsx";
import { ReelsPage } from "./pages/Reels.tsx";
import { ProfilePage } from "./pages/Profile.tsx";
import { SavedPage } from "./pages/Saved.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { TagPage } from "./pages/TagPage.tsx";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/reset" element={<ResetPasswordPage />} />
      <Route path="*" element={<SignedIn />} />
    </Routes>
  );
}

/**
 * Everything behind the sign-in gate.
 *
 * This sits above the routed pages so it can read the real location: opening a
 * post from inside the app records where you came from, and that page keeps
 * rendering underneath while the post is layered over it. The post still owns a
 * real URL, so sharing, refreshing and the back button behave normally — but it
 * also gets a backdrop and a close button, which a plain route change cannot
 * have. Land on /p/:id directly and there is no background, so it renders as an
 * ordinary page instead.
 */
function SignedIn() {
  const location = useLocation();
  const navigate = useNavigate();
  const background = (location.state as { background?: Location } | null)?.background;
  const openedPost = background ? matchPath("/p/:id", location.pathname)?.params.id : undefined;

  return (
    <RequireAuth>
      {/* Calls live above the shell so one can arrive on any page. */}
      <CallProvider>
        <UIProvider>
          <Routes location={background ?? location}>
            <Route element={<AppShell />}>
              <Route path="/" element={<FeedPage />} />
              <Route path="/explore" element={<ExplorePage />} />
              <Route path="/reels" element={<ReelsPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/:id" element={<MessagesPage />} />
              <Route path="/saved" element={<SavedPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/tags/:tag" element={<TagPage />} />
              <Route path="/p/:id" element={<PostPage />} />
              {/* Usernames live at the root, so this must stay last. */}
              <Route path="/:username" element={<ProfilePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>

          {openedPost && (
            <PostDialog onClose={() => navigate(-1)}>
              <PostPage postId={openedPost} inDialog />
            </PostDialog>
          )}
        </UIProvider>
        <CallOverlay />
      </CallProvider>
    </RequireAuth>
  );
}
