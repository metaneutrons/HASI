import { WorkspaceShell } from "@/components/app-shell";
import { PluginAccountConsent } from "@/components/plugin-account-consent";

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const id = params.installationId;
  const state = params.state;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) return <WorkspaceShell><p role="alert">Dieser Anmeldevorgang ist ungültig. Öffne „Verbundene Dienste“ und beginne erneut.</p></WorkspaceShell>;
  return <WorkspaceShell><PluginAccountConsent installationId={id} state={state} /></WorkspaceShell>;
}
