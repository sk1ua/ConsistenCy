/**
 * CapabilityBoundRepoFacade — Kernel-authorized, snapshot-backed repository
 * reads. Possessing this facade (or the snapshot identity) grants nothing by
 * itself: every read is authorized per-call as repo.read.
 */

import {
  CapabilityHandle,
  Principal,
  RepositoryResource,
  SyscallGateway,
} from "@consistency/kernel";

export interface SnapshotFileLike {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface CapabilityBoundRepoFacadeOptions {
  readonly principal: Principal;
  readonly handle: CapabilityHandle;
  readonly resource: RepositoryResource;
  readonly gateway: SyscallGateway;
  /** Trusted SHA-pinned snapshot — supplied by the runtime. */
  readonly snapshot: {
    readFile(path: string): SnapshotFileLike;
  };
}

export class CapabilityBoundRepoFacade {
  readonly #principal: Principal;
  readonly #handle: CapabilityHandle;
  readonly #resource: RepositoryResource;
  readonly #gateway: SyscallGateway;
  readonly #snapshot: CapabilityBoundRepoFacadeOptions["snapshot"];

  constructor(options: CapabilityBoundRepoFacadeOptions) {
    this.#principal = options.principal;
    this.#handle = options.handle;
    this.#resource = options.resource;
    this.#gateway = options.gateway;
    this.#snapshot = options.snapshot;
  }

  /** repo.read — authorized per-call; content comes from the pinned snapshot. */
  readFile(path: string): Promise<SnapshotFileLike> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#handle,
        action: "repo.read",
        resource: this.#resource,
        path,
      },
      () => ({ value: this.#snapshot.readFile(path) }),
    );
  }
}
