#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUESTS = 40;
const KNOWLEDGE_PLUGIN_ID = "de.hsh.hasi.knowledge";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function resolveBaseUrl() {
  const value = process.env.BASE_URL ?? process.argv[2] ?? DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("BASE_URL must be a valid loopback HTTP URL.");
  }
  assert(url.protocol === "http:", "BASE_URL must use HTTP.");
  assert(
    ["127.0.0.1", "localhost"].includes(url.hostname),
    "BASE_URL must target 127.0.0.1 or localhost.",
  );
  assert(url.pathname === "/" && !url.search && !url.hash, "BASE_URL must be an origin without a path.");
  return url;
}

const baseUrl = resolveBaseUrl();
const cookies = new Map();
let requestCount = 0;

function absorbCookies(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);

  for (const value of values) {
    const [pair, ...attributes] = value.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
    if (expired || cookieValue === "") cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

async function request(label, pathname, options = {}) {
  requestCount += 1;
  assert(requestCount <= MAX_REQUESTS, "Smoke run exceeded its request limit.");
  assert(pathname.startsWith("/"), "Smoke request path must be origin-relative.");

  const method = options.method ?? "GET";
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", options.origin ?? baseUrl.origin);
  }
  if (cookies.size > 0) {
    headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  }

  let response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`${label}: request failed (${error instanceof Error ? error.name : "network error"}).`);
  }

  absorbCookies(response.headers);
  const text = await response.text();
  assert(Buffer.byteLength(text) <= MAX_RESPONSE_BYTES, `${label}: response exceeded the size limit.`);
  const expectedStatus = options.status ?? 200;
  assert(response.status === expectedStatus, `${label}: expected HTTP ${expectedStatus}, received ${response.status}.`);

  let data;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      data = JSON.parse(text);
    } catch {
      fail(`${label}: response was not valid JSON.`);
    }
  }
  return { response, data, text };
}

function passed(label) {
  process.stdout.write(`PASS ${label}\n`);
}

function jsonRequest(label, pathname, body, status = 200, options = {}) {
  return request(label, pathname, { method: "POST", body, status, ...options });
}

async function main() {
  const landing = await request("web server", "/");
  assert(landing.response.headers.get("content-type")?.includes("text/html"), "web server: expected an HTML response.");
  passed("Next.js standalone server responds");

  const session = await request("anonymous session", "/api/session");
  assert(session.data?.user === null, "anonymous session: expected no signed-in user.");
  passed("anonymous session is unauthenticated");

  await request("anonymous protected resources", "/api/resources", { status: 401 });
  passed("anonymous API access is denied");

  const studentLogin = await jsonRequest("student login", "/api/dev/login", { personaId: "student" });
  assert(studentLogin.data?.user?.role === "student", "student login: expected the student demo identity.");
  passed("explicit student demo login works");

  await jsonRequest("same-origin empty chat request", "/api/chat", { history: [] }, 400);
  await jsonRequest("cross-origin empty chat request", "/api/chat", { history: [] }, 403, {
    origin: "https://attacker.invalid",
  });
  passed("chat rejects invalid input and untrusted origins before model calls");

  const roomsResult = await request("room catalog", "/api/resources");
  const rooms = roomsResult.data?.resources;
  assert(Array.isArray(rooms) && rooms.length === 30, "room catalog: expected 30 snapshot rooms.");
  const knownRooms = rooms.filter((room) => Number.isInteger(room.capacity));
  const unknownRooms = rooms.filter((room) => room.capacity === null);
  assert(knownRooms.length === 6 && unknownRooms.length === 24, "room catalog: expected six known and 24 unknown capacities.");
  const selectedFixtureRooms = knownRooms.filter((room) => room.id === "180224");
  assert(selectedFixtureRooms.length === 1, "room catalog: expected the selected fixture room exactly once.");
  const bookableRoom = selectedFixtureRooms[0];
  assert(bookableRoom.capacity === 8 && bookableRoom.serviceId === "65625", "room catalog: selected booking fixture metadata changed.");
  passed("30 fixture rooms preserve six known and 24 unknown capacities");

  const studentTools = await request("student tools", "/api/tools");
  assert(studentTools.data?.tools?.some((tool) => tool.pluginId === KNOWLEDGE_PLUGIN_ID && tool.name === "knowledge.search"), "student tools: expected the enabled knowledge search tool.");
  passed("enabled knowledge tool is available to the student identity");

  const search = await jsonRequest("knowledge query", "/api/tools/call", {
    pluginId: KNOWLEDGE_PLUGIN_ID,
    name: "knowledge.search",
    arguments: { query: "Morgenstern-Lab WLAN", limit: 3 },
  });
  assert(search.data?.documents?.some((document) => document.id === "svc-001" && document.synthetic === true), "knowledge query: expected the synthetic Morgenstern-Lab fixture.");
  passed("knowledge search returns a synthetic source");

  await request("student admin retrieval denial", "/api/admin/plugins", { status: 403 });
  await request("student restricted document denial", "/api/knowledge/documents/int-013", { status: 404 });
  passed("student identity cannot retrieve admin-only material");

  const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const bookingInput = {
    resourceId: bookableRoom.id,
    serviceId: bookableRoom.serviceId,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
  const availability = await jsonRequest("booking availability", "/api/availability", {
    resourceId: bookingInput.resourceId,
    serviceId: bookingInput.serviceId,
    startDate: bookingInput.startDate,
    durationMinutes: 60,
  });
  assert(availability.data?.intervals?.some((interval) => interval.available === true && Date.parse(interval.startDate) === start.getTime()), "booking availability: expected the selected fixture time to be free.");
  const proposal = await jsonRequest("room booking proposal", "/api/proposals", bookingInput);
  assert(proposal.data?.proposal?.status === "pending" && typeof proposal.data.proposal.id === "string", "room booking proposal: expected a pending confirmation card.");
  const confirmationPath = `/api/proposals/${encodeURIComponent(proposal.data.proposal.id)}/confirm`;
  const firstConfirmation = await jsonRequest("room booking confirmation", confirmationPath, {});
  assert(firstConfirmation.data?.proposal?.status === "confirmed" && typeof firstConfirmation.data.bookingId === "string", "room booking confirmation: expected one completed synthetic booking.");
  const replay = await jsonRequest("idempotent confirmation replay", confirmationPath, {});
  assert(replay.data?.proposal?.status === "confirmed" && replay.data.bookingId === firstConfirmation.data.bookingId, "idempotent confirmation replay: expected the original booking result.");
  const bookings = await request("booking reload", "/api/bookings");
  const matchingBookings = bookings.data?.bookings?.filter((booking) => booking.startDate === bookingInput.startDate && booking.resourceName === bookableRoom.name);
  assert(matchingBookings?.length === 1, "booking reload: expected exactly one matching fixture booking.");
  passed("room booking requires confirmation and remains single after reload");

  const adminLogin = await jsonRequest("admin demo login", "/api/dev/login", { personaId: "admin" });
  assert(adminLogin.data?.user?.role === "admin", "admin login: expected the administrator demo identity.");
  const adminPlugins = await request("admin plugin retrieval", "/api/admin/plugins");
  assert(adminPlugins.data?.plugins?.some((plugin) => plugin.id === KNOWLEDGE_PLUGIN_ID), "admin plugin retrieval: expected the installed knowledge plugin.");
  const adminDocument = await request("admin document retrieval", "/api/knowledge/documents/int-013");
  assert(adminDocument.data?.document?.id === "int-013" && adminDocument.data.document.synthetic === true, "admin document retrieval: expected the restricted synthetic fixture.");
  passed("admin identity can retrieve restricted demo material");

  await jsonRequest("disable knowledge plugin", `/api/admin/plugins/${KNOWLEDGE_PLUGIN_ID}/enabled`, { enabled: false });
  try {
    const availableTools = await request("disabled plugin tools", "/api/tools");
    assert(!availableTools.data?.tools?.some((tool) => tool.pluginId === KNOWLEDGE_PLUGIN_ID && tool.name === "knowledge.search"), "disabled plugin tools: knowledge search should be hidden.");
    await jsonRequest("disabled plugin invocation", "/api/tools/call", {
      pluginId: KNOWLEDGE_PLUGIN_ID,
      name: "knowledge.search",
      arguments: { query: "Morgenstern-Lab WLAN", limit: 3 },
    }, 409);
  } finally {
    await jsonRequest("restore knowledge plugin", `/api/admin/plugins/${KNOWLEDGE_PLUGIN_ID}/enabled`, { enabled: true });
  }
  passed("disabled plugins are hidden and cannot be invoked");

  await jsonRequest("logout", "/api/logout", {});
  const loggedOut = await request("logged-out session", "/api/session");
  assert(loggedOut.data?.user === null, "logout: expected the session to be cleared.");
  await request("post-logout protected resources", "/api/resources", { status: 401 });
  passed("logout clears access to protected APIs");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unexpected error";
  process.stderr.write(`HASI container smoke failed: ${message}\n`);
  process.exitCode = 1;
});
