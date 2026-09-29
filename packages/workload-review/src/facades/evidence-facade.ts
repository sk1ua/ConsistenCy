/**
 * CapabilityBoundEvidenceFacade — Kernel-authorized access to the run's
 * EvidenceStore. Agents receive this facade, never the raw store.
 */

import {
  CapabilityHandle,
  EvidenceInput,
  EvidenceResource,
  EvidenceSnapshot,
  Principal,
  SyscallGateway,
} from "@consistency/kernel";

export interface CapabilityBoundEvidenceFacadeOptions {
  readonly principal: Principal;
  /** Capability for evidence.read (or both read+write per profile). */
  readonly readHandle: CapabilityHandle;
  readonly writeHandle?: CapabilityHandle;
  readonly resource: EvidenceResource;
  readonly gateway: SyscallGateway;
  /** Trusted store — supplied by the runtime, invisible to the Agent. */
  readonly store: {
    list(): readonly EvidenceSnapshot[];
    add(input: EvidenceInput): EvidenceSnapshot;
  };
}

export class CapabilityBoundEvidenceFacade {
  readonly #principal: Principal;
  readonly #readHandle: CapabilityHandle;
  readonly #writeHandle?: CapabilityHandle;
  readonly #resource: EvidenceResource;
  readonly #gateway: SyscallGateway;
  readonly #store: CapabilityBoundEvidenceFacadeOptions["store"];

  constructor(options: CapabilityBoundEvidenceFacadeOptions) {
    this.#principal = options.principal;
    this.#readHandle = options.readHandle;
    this.#writeHandle = options.writeHandle;
    this.#resource = options.resource;
    this.#gateway = options.gateway;
    this.#store = options.store;
  }

  /** evidence.read — denied per-call by the Kernel without the capability. */
  list(): Promise<readonly EvidenceSnapshot[]> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#readHandle,
        action: "evidence.read",
        resource: this.#resource,
      },
      () => ({ value: Object.freeze([...this.#store.list()]) }),
    );
  }

  /**
   * evidence.write — only available when the profile included the
   * capability; the Kernel denies otherwise (action/handle mismatch).
   */
  write(input: EvidenceInput): Promise<EvidenceSnapshot> {
    if (!this.#writeHandle) {
      return Promise.reject(new Error("evidence.write capability was not granted to this agent"));
    }
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#writeHandle,
        action: "evidence.write",
        resource: this.#resource,
      },
      () => ({ value: this.#store.add(input) }),
    );
  }
}
