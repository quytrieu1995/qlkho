import type { SocketStream } from "@fastify/websocket";

const clients = new Set<SocketStream["socket"]>();

export function registerSocket(socket: SocketStream["socket"]): void {
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
