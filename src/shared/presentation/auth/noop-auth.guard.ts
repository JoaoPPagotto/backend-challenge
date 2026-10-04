import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Authentication is intentionally not implemented (it scores no points and must not
 * compete with financial correctness). This global guard is the explicit extension point:
 * replace it with a JWT/OIDC guard (e.g. Keycloak JWKS validation). Health and metrics
 * endpoints stay open; queue messages are an internal trusted channel.
 * See ARCHITECTURE.md § Authentication.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
