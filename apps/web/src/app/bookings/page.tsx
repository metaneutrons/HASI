import { BookingsPage } from "@/components/bookings-page";
import { WorkspaceShell } from "@/components/app-shell";

export default function BookingsRoute() {
  return (
    <WorkspaceShell>
      <BookingsPage />
    </WorkspaceShell>
  );
}
