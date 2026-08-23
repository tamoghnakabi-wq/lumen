import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { del, get, patch, post } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import type { Collection, Post } from "../lib/types.ts";
import { Menu } from "../components/Menu.tsx";
import { Modal } from "../components/Modal.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PostGrid } from "../components/PostGrid.tsx";
import { EmptyState, ErrorState, GridSkeleton, Spinner } from "../components/States.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

type Page = { posts: Post[]; nextCursor: string | null };

export function SavedPage() {
  // null = everything saved; otherwise a collection id.
  const [active, setActive] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const toast = useToast();

  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => get<{ collections: Collection[] }>("/collections"),
  });

  const query = useInfiniteQuery({
    queryKey: active ? ["collection-posts", active] : ["saved"],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      get<Page>(
        active
          ? `/collections/${active}/posts${pageParam ? `?cursor=${pageParam}` : ""}`
          : `/me/saved${pageParam ? `?cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const createCollection = useMutation({
    mutationFn: () => post<{ collection: Collection }>("/collections", { name }),
    onSuccess: () => {
      setName("");
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      toast("Collection created", "success");
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not create the collection.", "error"),
  });

  const renameCollection = useMutation({
    mutationFn: () => patch(`/collections/${renaming!.id}`, { name }),
    onSuccess: () => {
      setRenaming(null);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not rename the collection.", "error"),
  });

  const removeCollection = useMutation({
    mutationFn: (id: string) => del(`/collections/${id}`),
    onSuccess: () => {
      setActive(null);
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      toast("Collection deleted — the posts are still saved", "success");
    },
  });

  const sentinel = useInfiniteScroll(
    () => !query.isFetchingNextPage && query.hasNextPage && query.fetchNextPage(),
    !!query.hasNextPage,
  );

  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  const list = collections.data?.collections ?? [];
  const current = list.find((c) => c.id === active) ?? null;

  return (
    <div className="mx-auto w-full max-w-[62rem] pb-10 sm:px-6">
      <PageHeader
        title="Saved"
        back
        action={
          <button
            onClick={() => {
              setName("");
              setCreating(true);
            }}
            className="btn btn-ghost px-3 py-1.5 text-[13px]"
          >
            <FolderPlus size={15} /> New
          </button>
        }
      />
      <p className="px-4 pb-3 text-sm text-muted sm:px-0">Only you can see what you’ve saved.</p>

      {/* Collection filter. "All" is the plain bookmark list. */}
      <div className="hide-scroll -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        <button
          onClick={() => setActive(null)}
          className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition ${
            active === null ? "border-accent bg-accent-soft font-medium" : "border-line hover:bg-raised"
          }`}
        >
          All saved
        </button>
        {list.map((collection) => (
          <button
            key={collection.id}
            onClick={() => setActive(collection.id)}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition ${
              active === collection.id ? "border-accent bg-accent-soft font-medium" : "border-line hover:bg-raised"
            }`}
          >
            {collection.name}
            <span className="text-xs text-muted">{collection.count}</span>
          </button>
        ))}
      </div>

      {current && (
        <div className="mb-3 flex items-center justify-between px-4 sm:px-0">
          <h2 className="text-base font-semibold tracking-tight">{current.name}</h2>
          <Menu
            trigger={<Pencil size={16} />}
            label="Collection options"
            items={[
              {
                label: "Rename",
                icon: <Pencil size={15} />,
                onSelect: () => {
                  setName(current.name);
                  setRenaming(current);
                },
              },
              {
                label: "Delete collection",
                icon: <Trash2 size={15} />,
                danger: true,
                onSelect: () => removeCollection.mutate(current.id),
              },
            ]}
          />
        </div>
      )}

      {query.isLoading ? (
        <GridSkeleton count={9} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState
          icon={<Bookmark size={22} />}
          title={current ? `${current.name} is empty` : "Nothing saved yet"}
          message={
            current
              ? "Add saved posts to this collection from the post menu."
              : "Tap the bookmark on any post to keep it here."
          }
        />
      ) : (
        <PostGrid posts={posts} />
      )}

      <div ref={sentinel} className="flex justify-center py-8">
        {query.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
      </div>

      <Modal
        open={creating || renaming !== null}
        onClose={() => {
          setCreating(false);
          setRenaming(null);
        }}
        title={renaming ? "Rename collection" : "New collection"}
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            renaming ? renameCollection.mutate() : createCollection.mutate();
          }}
          className="p-5"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 40))}
            placeholder="Places to go"
            className="field"
            autoFocus
          />
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-ghost flex-1 justify-center"
              onClick={() => {
                setCreating(false);
                setRenaming(null);
              }}
            >
              Cancel
            </button>
            <button className="btn btn-primary flex-1 justify-center" disabled={!name.trim()}>
              {createCollection.isPending || renameCollection.isPending ? (
                <Spinner size={15} />
              ) : renaming ? (
                "Rename"
              ) : (
                "Create"
              )}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
