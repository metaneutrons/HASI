import { AdminPage } from "@/components/admin-page";
import { WorkspaceShell } from "@/components/app-shell";

export default function AdminRoute() {
  return (
    <WorkspaceShell>
      <AdminPage />
    </WorkspaceShell>
  );
}
