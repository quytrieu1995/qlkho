import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";

export type UserRole = "admin" | "sales" | "kho";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

const HASH_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, HASH_KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) {
    return false;
  }
  const verifyHash = crypto.scryptSync(password, salt, HASH_KEY_LENGTH).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(verifyHash, "hex"));
}

export async function findUserByUsername(username: string): Promise<(AuthUser & { password_hash: string }) | null> {
  const { rows } = await pool.query(
    `
      SELECT id, username, role, password_hash
      FROM app_users
      WHERE username = $1
        AND is_active = true
      LIMIT 1
    `,
    [username]
  );
  return rows[0] ?? null;
}

export function getRequester(request: FastifyRequest): AuthUser {
  return request.user as AuthUser;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    void reply.code(401).send({ error: "Unauthorized" });
  }
}

export function requireRoles(roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply);
    if (reply.sent) {
      return;
    }
    const user = getRequester(request);
    if (!roles.includes(user.role)) {
      void reply.code(403).send({ error: "Forbidden" });
    }
  };
}
