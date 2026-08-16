import { type SourceDescriptor, type SourceTier, TIER_BASE_RELIABILITY } from '../domain/types.js';

/**
 * Source reliability registry.
 *
 * Reliability is a *prior* on the publisher, deliberately conservative. It is
 * one input to the verification pipeline, never a substitute for it: a
 * reliability of 0.98 still does not make a single unconfirmed claim
 * tradeable.
 */

export function describeSource(
  input: Omit<SourceDescriptor, 'reliability' | 'authoritative'> &
    Partial<Pick<SourceDescriptor, 'reliability' | 'authoritative'>>,
): SourceDescriptor {
  return {
    ...input,
    reliability: input.reliability ?? TIER_BASE_RELIABILITY[input.tier],
    authoritative: input.authoritative ?? isAuthoritativeTier(input.tier),
  };
}

export function isAuthoritativeTier(tier: SourceTier): boolean {
  return tier === 'official' || tier === 'regulatory_filing' || tier === 'exchange';
}

class SourceRegistry {
  private readonly sources = new Map<string, SourceDescriptor>();

  register(descriptor: SourceDescriptor): SourceDescriptor {
    this.sources.set(descriptor.id, descriptor);
    return descriptor;
  }

  registerAll(descriptors: SourceDescriptor[]): void {
    for (const d of descriptors) this.register(d);
  }

  get(id: string): SourceDescriptor | undefined {
    return this.sources.get(id);
  }

  /** Reliability for an id; unknown publishers get the lowest prior. */
  reliabilityOf(id: string): number {
    return this.sources.get(id)?.reliability ?? TIER_BASE_RELIABILITY.unknown;
  }

  tierOf(id: string): SourceTier {
    return this.sources.get(id)?.tier ?? 'unknown';
  }

  isAuthoritative(id: string): boolean {
    return this.sources.get(id)?.authoritative ?? false;
  }

  list(): SourceDescriptor[] {
    return [...this.sources.values()];
  }

  clear(): void {
    this.sources.clear();
  }
}

export const sourceRegistry = new SourceRegistry();
