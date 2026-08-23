import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, post as postJson } from "../lib/api.ts";
import { patchPost, removePost } from "../lib/postCache.ts";
import { useToast } from "../lib/toast.tsx";
import type { Post } from "../lib/types.ts";

/**
 * Like/save/delete with optimistic updates. The server response replaces the
 * optimistic value, so counts stay exact even when several people act at once.
 */
export function usePostActions(post: Post) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  const toggleLike = useCallback(async () => {
    const liked = post.viewer.liked;
    patchPost(queryClient, {
      ...post,
      viewer: { ...post.viewer, liked: !liked },
      counts: { ...post.counts, likes: Math.max(0, post.counts.likes + (liked ? -1 : 1)) },
    });
    try {
      const data = liked
        ? await del<{ post: Post }>(`/posts/${post.id}/like`)
        : await postJson<{ post: Post }>(`/posts/${post.id}/like`);
      patchPost(queryClient, data.post);
    } catch (err) {
      patchPost(queryClient, post);
      toast(err instanceof Error ? err.message : "Could not update like.", "error");
    }
  }, [post, queryClient, toast]);

  const toggleRepost = useCallback(async () => {
    const reposted = post.viewer.reposted;
    patchPost(queryClient, {
      ...post,
      viewer: { ...post.viewer, reposted: !reposted },
      counts: { ...post.counts, reposts: Math.max(0, post.counts.reposts + (reposted ? -1 : 1)) },
    });
    try {
      const data = reposted
        ? await del<{ post: Post }>(`/posts/${post.id}/repost`)
        : await postJson<{ post: Post }>(`/posts/${post.id}/repost`);
      patchPost(queryClient, data.post);
      // A repost changes what belongs in the feed and on the profile's tab.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["profile-reposts"] });
      toast(reposted ? "Repost removed" : "Reposted", "success");
    } catch (err) {
      patchPost(queryClient, post);
      toast(err instanceof Error ? err.message : "Could not repost.", "error");
    }
  }, [post, queryClient, toast]);

  const toggleSave = useCallback(async () => {
    const saved = post.viewer.saved;
    patchPost(queryClient, { ...post, viewer: { ...post.viewer, saved: !saved } });
    try {
      const data = saved
        ? await del<{ post: Post }>(`/posts/${post.id}/save`)
        : await postJson<{ post: Post }>(`/posts/${post.id}/save`);
      patchPost(queryClient, data.post);
      void queryClient.invalidateQueries({ queryKey: ["saved"] });
      toast(saved ? "Removed from saved" : "Saved", "success");
    } catch (err) {
      patchPost(queryClient, post);
      toast(err instanceof Error ? err.message : "Could not save post.", "error");
    }
  }, [post, queryClient, toast]);

  const remove = useCallback(async () => {
    setDeleting(true);
    try {
      await del(`/posts/${post.id}`);
      removePost(queryClient, post.id);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast("Post deleted", "success");
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete post.", "error");
      return false;
    } finally {
      setDeleting(false);
    }
  }, [post.id, queryClient, toast]);

  return { toggleLike, toggleRepost, toggleSave, remove, deleting };
}
