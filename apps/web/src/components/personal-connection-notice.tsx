"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { parsePluginAccountList, type PluginAccountPanelAccount } from "@/lib/plugin-accounts";

export function PersonalConnectionNotice() {
  const [accounts, setAccounts] = useState<PluginAccountPanelAccount[]>([]);
  useEffect(() => {
    let active = true;
    void apiRequest<unknown>("/api/plugin-accounts").then(payload => { if (active) setAccounts(parsePluginAccountList(payload).filter(account => account.status !== "linked")); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!accounts.length) return null;
  return <aside className="personal-connection-notice" aria-label="Persönliche Dienstanmeldung"><p><strong>{accounts.map(account => account.label).join(", ")}</strong>: Verbinde oder erneuere dein Konto, um die freigegebenen Funktionen im Chat zu nutzen. Dein Entwurf bleibt erhalten.</p><Link className="chat-card-action" href="/account/connections?returnTo=%2F">Verbundene Dienste öffnen</Link></aside>;
}
