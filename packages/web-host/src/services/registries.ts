import type {
  CommandContribution,
  InspectorContribution,
  NavItem,
  RouteContribution,
  SlotName,
  StatusItem,
} from "../types.js";
import type { ReactNode } from "react";

function byOrder<T extends { order?: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

export class NavRegistry {
  #items = new Map<string, NavItem>();
  register(item: NavItem): () => void {
    this.#items.set(item.id, item);
    return () => this.#items.delete(item.id);
  }
  list(): NavItem[] {
    return byOrder([...this.#items.values()]);
  }
}

export class CommandRegistry {
  #items = new Map<string, CommandContribution>();
  register(item: CommandContribution): () => void {
    this.#items.set(item.id, item);
    return () => this.#items.delete(item.id);
  }
  list(): CommandContribution[] {
    return [...this.#items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  get(id: string): CommandContribution | undefined {
    return this.#items.get(id);
  }
}

export class RouteRegistry {
  #items = new Map<string, RouteContribution>();
  register(item: RouteContribution): () => void {
    this.#items.set(item.id, item);
    return () => this.#items.delete(item.id);
  }
  list(): RouteContribution[] {
    return [...this.#items.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
}

export class InspectorRegistry {
  #items = new Map<string, InspectorContribution>();
  register(item: InspectorContribution): () => void {
    this.#items.set(item.id, item);
    return () => this.#items.delete(item.id);
  }
  list(): InspectorContribution[] {
    return [...this.#items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export class StatusRegistry {
  #items = new Map<string, StatusItem>();
  register(item: StatusItem): () => void {
    this.#items.set(item.id, item);
    return () => this.#items.delete(item.id);
  }
  list(): StatusItem[] {
    return byOrder([...this.#items.values()]);
  }
}

export class SlotRegistry {
  #slots = new Map<SlotName, ReactNode>();
  set(name: SlotName, node: ReactNode): () => void {
    this.#slots.set(name, node);
    return () => {
      if (this.#slots.get(name) === node) this.#slots.delete(name);
    };
  }
  get(name: SlotName): ReactNode | undefined {
    return this.#slots.get(name);
  }
}

export type UiServices = {
  nav: NavRegistry;
  commands: CommandRegistry;
  routes: RouteRegistry;
  inspector: InspectorRegistry;
  status: StatusRegistry;
  slots: SlotRegistry;
};

export function createUiServices(): UiServices {
  return {
    nav: new NavRegistry(),
    commands: new CommandRegistry(),
    routes: new RouteRegistry(),
    inspector: new InspectorRegistry(),
    status: new StatusRegistry(),
    slots: new SlotRegistry(),
  };
}
