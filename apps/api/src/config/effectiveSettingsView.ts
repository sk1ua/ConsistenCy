import {
  effectiveSettingsViewSchema,
  type EffectiveSettingItemView,
  type EffectiveSettingsView
} from "@consistency/schema";
import type { EffectiveSettingItem, EffectiveSettingsResult } from "./effectiveSettings";

/**
 * H09 — renderer-facing projection of the H07 effective configuration
 * resolution.
 *
 * The view builder is defense in depth: even if a resolver bug ever attached
 * a plaintext secret to an item, the explicit field picking below would drop
 * it. Secrets and local filesystem paths contribute `configured` presence and
 * source/lock/restart metadata only — never a value.
 */

/** Local filesystem locations stay server-side; the renderer sees presence only. */
const PATH_VALUE_KEYS = new Set([
  "databasePath",
  "workspaceRoot",
  "localReviewRoots"
]);

function projectItem(item: EffectiveSettingItem): EffectiveSettingItemView {
  const includeValue = !item.isSecret && !PATH_VALUE_KEYS.has(item.key);
  return effectiveSettingsViewSchema.shape.items.valueSchema.parse({
    key: item.key,
    envVar: item.envVar,
    source: item.source,
    configured: item.configured,
    isSecret: item.isSecret,
    lockedByEnv: item.lockedByEnv,
    restartRequired: item.restartRequired,
    ...(includeValue && item.value !== undefined ? { value: item.value } : {})
  });
}

const EMPTY_GROUPS: EffectiveSettingsView["groups"] = {
  llm: [],
  github: [],
  runtime: [],
  general: []
};

/**
 * Project the resolver result into the grouped renderer view. Items are
 * keyed by canonical key; `groups` carries category-ordered lists consumed
 * directly by the settings form sections.
 */
export function toEffectiveSettingsView(result: EffectiveSettingsResult): EffectiveSettingsView {
  const items: Record<string, EffectiveSettingItemView> = {};
  const groups: EffectiveSettingsView["groups"] = { ...EMPTY_GROUPS };

  for (const [key, item] of Object.entries(result.structured.llm)) {
    const view = projectItem(item);
    items[key] = view;
    groups.llm.push(view);
  }
  for (const [key, item] of Object.entries(result.structured.github)) {
    const view = projectItem(item);
    items[key] = view;
    groups.github.push(view);
  }
  for (const [key, item] of Object.entries(result.structured.runtime)) {
    const view = projectItem(item);
    items[key] = view;
    groups.runtime.push(view);
  }
  for (const [key, item] of Object.entries(result.structured.general)) {
    const view = projectItem(item);
    items[key] = view;
    groups.general.push(view);
  }

  return effectiveSettingsViewSchema.parse({
    items,
    groups,
    overriddenByEnvironment: result.overriddenByEnvironment,
    restartRequiredKeys: result.restartRequiredKeys
  });
}
