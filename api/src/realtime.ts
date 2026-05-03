type LiveSocket = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  on: (event: "close", listener: () => void) => void;
};

const clients = new Set<LiveSocket>();

export function registerSocket(socket: LiveSocket): void {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
}

export function broadcast(event: string, payload: Record<string, unknown>): void {
  const message = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}
