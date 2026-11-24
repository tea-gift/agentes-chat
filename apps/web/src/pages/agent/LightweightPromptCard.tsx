import { useUpdateAgent } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { Card, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Lightweight prompt: the agent's runs use a short system prompt (a few behaviour rules)
 * instead of the platform's full "How you work" + "How to reply" blocks, and skip the capabilities/team blocks.
 * For simple DM chat bots on small models or tight token budgets; not for agents that act on the person's behalf.
 * Whoever manages the agent (`managesAgent`) flips the switch. A flip saves at once, outside the page's save bar.
 * Anyone else reads the line.
 */
export function LightweightPromptCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const update = useUpdateAgent(org.id, agent.id);
  const saved = agent.lightweightPrompt ?? false;
  const asked = update.isPending ? update.variables?.lightweightPrompt : undefined;
  const title = t("lightweightPrompt.title");
  return (
    <Card as="section" aria-label={title}>
      <div className="settings-rows">
        <PrefRow
          id="agent-lightweight-prompt"
          icon="bolt"
          label={title}
          status={t("lightweightPrompt.help")}
          control={
            <Switch
              checked={asked ?? saved}
              onCheckedChange={(next) => update.mutate({ lightweightPrompt: next })}
              disabled={!managesAgent(agent)}
              aria-label={title}
            />
          }
        />
      </div>
    </Card>
  );
}
