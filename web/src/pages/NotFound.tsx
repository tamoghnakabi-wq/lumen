import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EmptyState } from "../components/States.tsx";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg">
      <EmptyState
        icon={<Compass size={22} />}
        title="This page doesn’t exist"
        message="The link may be broken, or the page may have moved."
        action={
          <Link to="/" className="btn btn-primary">
            Back to feed
          </Link>
        }
      />
    </div>
  );
}
