export function reportLanguageInstruction(language: "zh-CN" | "en-US"): string {
  return language === "zh-CN"
    ? "Write all prose (finding titles, evidence, reasoning, recommendations) in Simplified Chinese (简体中文). Keep code identifiers, file paths, technical terms, and severity labels in English."
    : "Write all prose in English.";
}
