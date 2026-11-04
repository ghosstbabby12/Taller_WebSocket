import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type Role = 'jurado' | 'auditor';

export interface Principal {
  role: Role;
  subject: string;
  expiresAt: number;
}

const principalSchema = z.object({
  role: z.enum(['jurado', 'auditor']),
  subject: z.string().min(1),
  expiresAt: z.number().int(),
});

export const constantTimeEquals = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Token firmado y sin estado: cualquier instancia lo valida sin sesiones ni afinidad (RT-2). */
export class TokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  issue(role: Role, subject: string, now = Date.now()): string {
    const principal: Principal = { role, subject, expiresAt: now + this.ttlSeconds * 1000 };
    const body = Buffer.from(JSON.stringify(principal)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string, now = Date.now()): Principal | null {
    const [body, signature] = token.split('.');
    if (!body || !signature || !constantTimeEquals(signature, this.sign(body))) return null;
    const parsed = principalSchema.safeParse(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
