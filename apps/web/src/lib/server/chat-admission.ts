import { checkRateLimit } from "@vercel/firewall";

async function admit(rateLimitKey: string) {
  if (!process.env.VERCEL) return true;
  const result = await checkRateLimit("hasi-chat", {
    headers: new Headers({ host: "hasi.metaneutrons.cc" }),
    rateLimitKey,
    timeout: 3000,
  });
  if (result.error) throw new Error("Chat admission unavailable");
  return !result.rateLimited;
}

export const admitChat = () => admit("hasi:groq:shared:v1");
// A separate per-workspace/account bucket never spends the inference budget.
export const admitTimestamps = (scope: string) => admit(`hasi:timestamps:v1:${scope}`);
