/**
 * Extension point for authentication (see ARCHITECTURE.md § Authentication).
 *
 * Today the provider identity is taken from the payload and is NOT verified. With an IdP
 * (Keycloak/Zitadel, OIDC client-credentials per provider) the adapter would read the
 * validated JWT claim `provider_id` and the use case would reject a payload whose
 * providerId differs from it.
 */
export interface ProviderIdentity {
  providerId: string;
  verified: boolean;
}

export interface ProviderIdentityPort {
  resolve(request: { headers: Record<string, unknown> }, claimedProviderId: string): ProviderIdentity;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

export class UnverifiedProviderIdentityAdapter implements ProviderIdentityPort {
  resolve(_request: { headers: Record<string, unknown> }, claimedProviderId: string): ProviderIdentity {
    return { providerId: claimedProviderId, verified: false };
  }
}
