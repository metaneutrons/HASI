import { AssistantPage } from "@/components/assistant-page";
import { WorkspaceShell } from "@/components/app-shell";

export default function HomePage() {
  return (
    <WorkspaceShell>
      <AssistantPage />
    </WorkspaceShell>
  );
}
