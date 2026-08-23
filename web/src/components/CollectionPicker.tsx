import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderPlus } from "lucide-react";
import { api, get, post } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { Modal } from "./Modal.tsx";
import { RowSkeleton, Spinner } from "./States.tsx";

type Entry = { id: string; name: string; contains: boolean };

/**
 * Files a post into collections. Adding implies bookmarking, which is enforced
 * server-side too, so the Saved tab and the collection never disagree.
 */
export function CollectionPicker({ open, onClose, postId }: { open: boolean; onClose: () => void; postId: string }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const toast = useToast();

  const list = useQuery({
    queryKey: ["collections-for", postId],
    queryFn: () => get<{ collections: Entry[] }>(`/collections/-/for-post/${postId}`),
    enabled: open,
  });

  const toggle = useMutation({
    mutationFn: ({ id, contains }: Entry) =>
      api(`/collections/${id}/posts/${postId}`, { method: contains ? "DELETE" : "PUT" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections-for", postId] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["saved"] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not update the collection.", "error"),
  });

  const create = useMutation({
    mutationFn: () => post<{ collection: { id: string } }>("/collections", { name }),
    onSuccess: async ({ collection }) => {
      setName("");
      setCreating(false);
      await api(`/collections/${collection.id}/posts/${postId}`, { method: "PUT" });
      void queryClient.invalidateQueries({ queryKey: ["collections-for", postId] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["saved"] });
      toast("Collection created", "success");
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not create the collection.", "error"),
  });

  return (
    <Modal open={open} onClose={onClose} title="Save to collection" size="sm">
      <div className="min-h-[10rem] overflow-y-auto p-3">
        {list.isLoading ? (
          <RowSkeleton count={3} />
        ) : (
          <>
            {list.data?.collections.length === 0 && !creating && (
              <p className="px-2 py-6 text-center text-sm text-muted">
                No collections yet. Create one to group saved posts.
              </p>
            )}
            {list.data?.collections.map((entry) => (
              <button
                key={entry.id}
                onClick={() => toggle.mutate(entry)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-raised"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-md border ${
                    entry.contains ? "border-accent bg-accent text-white" : "border-line"
                  }`}
                >
                  {entry.contains && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="flex-1 truncate text-sm font-medium">{entry.name}</span>
              </button>
            ))}

            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) create.mutate();
                }}
                className="mt-2 flex gap-2 px-1"
              >
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 40))}
                  placeholder="Collection name"
                  className="field"
                  autoFocus
                />
                <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
                  {create.isPending ? <Spinner size={14} /> : "Create"}
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-accent transition hover:bg-raised"
              >
                <FolderPlus size={17} /> New collection
              </button>
            )}
          </>
        )}
      </div>
      <footer className="border-t border-line p-3">
        <button className="btn btn-ghost w-full justify-center" onClick={onClose}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
