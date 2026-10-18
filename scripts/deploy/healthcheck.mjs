// Coolify executes this directly; the minimal runtime needs no curl or wget.
try {
  const response = await fetch('http://127.0.0.1:3000/api/health', {
    redirect: 'error', signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) process.exit(1);
  const body = await response.json();
  process.exit(body.status === 'ready' && /^[a-f0-9]{40}$/.test(body.revision) ? 0 : 1);
} catch {
  process.exit(1);
}
