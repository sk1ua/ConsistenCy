import { ExternalLink } from "lucide-react";
import { useI18n } from "../i18n";

export const SETTING_HELP_LINKS = Object.freeze({
  openaiApiKeys: "https://platform.openai.com/api-keys",
  deepseekApi: "https://api-docs.deepseek.com/api/deepseek-api",
  githubApp: "https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app",
  githubPrivateKey: "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps",
  githubWebhook: "https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps",
  githubPat: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
} as const);

export function SettingHelp({ id, text, href, linkLabel = "Open official guide" }: {
  id: string;
  text: string;
  href?: string;
  linkLabel?: string;
}) {
  const { t } = useI18n();
  return <small id={id} className="setting-help">
    <span>{t(text)}</span>
    {href && <a href={href} target="_blank" rel="noopener noreferrer">{t(linkLabel)}<ExternalLink aria-hidden="true" size={12} /></a>}
  </small>;
}
