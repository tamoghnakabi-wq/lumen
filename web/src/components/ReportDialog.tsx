import { useState } from "react";
import { post } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { Modal } from "./Modal.tsx";
import { Spinner } from "./States.tsx";

const REASONS = [
  { value: "spam", label: "Spam or scam" },
  { value: "nudity", label: "Nudity or sexual content" },
  { value: "hate", label: "Hate speech or symbols" },
  { value: "violence", label: "Violence or dangerous content" },
  { value: "harassment", label: "Bullying or harassment" },
  { value: "misinformation", label: "False information" },
  { value: "other", label: "Something else" },
] as const;

export function ReportDialog({
  open,
  onClose,
  targetType,
  targetId,
  targetLabel,
}: {
  open: boolean;
  onClose: () => void;
  targetType: "post" | "user" | "comment";
  targetId: string;
  targetLabel?: string;
}) {
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      await post("/reports", { targetType, targetId, reason, note });
      toast("Report received. Thanks for letting us know.", "success");
      setReason("");
      setNote("");
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send report.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Report ${targetLabel ?? targetType}`} size="sm">
      <div className="overflow-y-auto p-5">
        <p className="text-sm text-muted">Why are you reporting this?</p>
        <div className="mt-3 space-y-1">
          {REASONS.map((r) => (
            <label
              key={r.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition ${
                reason === r.value ? "border-accent bg-accent-soft" : "border-line hover:bg-raised"
              }`}
            >
              <input
                type="radio"
                name="reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="accent-[var(--accent)]"
              />
              {r.label}
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          placeholder="Add any detail that would help (optional)"
          rows={3}
          className="field mt-3 resize-none"
        />
        <div className="mt-4 flex gap-2">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary flex-1 justify-center" onClick={submit} disabled={!reason || busy}>
            {busy ? <Spinner size={15} /> : "Submit report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
