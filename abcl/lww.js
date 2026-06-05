// C4: per-cell Last-Writer-Wins for the spreadsheet's WebSocket
// realtime collab.  Each update carries a Lamport timestamp and
// the originating client id; ties on ts break by larger origin
// (lexicographic, deterministic across peers).
export function lwwWins(incoming, current) {
  if (!current) return true;
  if (incoming.ts !== current.ts) return incoming.ts > current.ts;
  return incoming.origin > current.origin;
}

export function newClientId() {
  return "c-" + Math.random().toString(36).slice(2, 8);
}
