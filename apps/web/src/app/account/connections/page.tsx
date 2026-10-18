import { WorkspaceShell } from "@/components/app-shell";
import { PluginAccountPanel } from "@/components/plugin-account-panel";

export default function ConnectionsPage() {
  return <WorkspaceShell><section className="page-content"><header><p className="eyebrow">Dein Konto</p><h1>Verbundene Dienste</h1><p>Verwalte deine persönlichen Anmeldungen. Deine Chats bleiben beim Trennen erhalten.</p></header><PluginAccountPanel /></section></WorkspaceShell>;
}
