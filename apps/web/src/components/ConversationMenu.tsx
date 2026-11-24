import { type Agent, type Member, useClearDm } from "@agenteschat/client";
import { Button, Dialog, DialogFooter, Menu } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { MenuEntries } from "@/components/DesktopMenus";
import { useAgentMenu, usePersonMenu } from "@/components/entity-menus";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { type WallpaperConversation, WallpaperDialog } from "@/components/WallpaperDialog";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";

/** In a DM's own header, what would only lead back to it: its DM, a mention of the one already here. */
const SELF_IN_DM = new Set(["dm", "mention"]);

/**
 * "Conversation background…" for a conversation's menus (its header's ⋯ and right click), and the background
 * dialog it opens, for this conversation alone. Render `dialog` once beside the menus.
 */
export function useConversationWallpaperMenu(conversation: WallpaperConversation): {
  entry: MenuEntry;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return {
    entry: {
      kind: "item",
      id: "wallpaper",
      label: t("settings.account.chat.wallpaper.menu"),
      icon: "image",
      run: () => setOpen(true),
    },
    dialog: <WallpaperDialog open={open} onOpenChange={setOpen} conversation={conversation} />,
  };
}

/** The entries as the menu opens: built then (who is working, what is unread), the name's heading left out. */
function Entries({ build }: { build: () => MenuEntry[] }) {
  return <MenuEntries entries={build().filter((e) => e.kind !== "header")} />;
}

/**
 * A conversation header's ⋯: the same list as its right click (`entity-menus.tsx`), without the name it is under,
 * built when it opens.
 */
export function ConversationMoreMenu({ build }: { build: () => MenuEntry[] }) {
  const { t } = useTranslation();
  const label = t("channel.header.more");
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="more"
          className="channel__icon"
          aria-label={label}
          title={label}
        />
      }
    >
      <Entries build={build} />
    </Menu>
  );
}

/** A DM header's ⋯: the agent's or the person's own list, with "Conversation background…" in it. */
export function DmMoreMenu({
  channelId,
  name,
  agent,
  person,
}: {
  channelId: string;
  name: string;
  agent?: Agent;
  person?: Member;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const agentEntries = useAgentMenu();
  const personEntries = usePersonMenu();
  const wallpaper = useConversationWallpaperMenu({
    channelId,
    dm: true,
    name,
    agentColor: agent ? colorOf(agent) : null,
  });
  // The clear, and the confirmation it asks first: every message of this DM goes, and there is no undo.
  const [clearing, setClearing] = useState(false);
  const clear = useClearDm(org.id);
  const build = (): MenuEntry[] => {
    const entries = agent
      ? agentEntries(agent, [wallpaper.entry])
      : person
        ? withEntry(personEntries(person), wallpaper.entry)
        : [wallpaper.entry];
    const filtered = entries.filter((e) => !(e.kind === "item" && SELF_IN_DM.has(e.id)));
    return [
      ...filtered,
      { kind: "separator" },
      {
        kind: "item",
        id: "clear-conversation",
        label: t("dm.clearConversation"),
        icon: "trash",
        danger: true,
        run: () => setClearing(true),
      },
    ];
  };
  return (
    <>
      <ConversationMoreMenu build={build} />
      {wallpaper.dialog}
      {clearing && (
        <Dialog
          open
          onOpenChange={(open) => !open && setClearing(false)}
          title={t("dm.clearTitle")}
          description={t("dm.clearText")}
          closeLabel={t("common.close")}
          width={460}
        >
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setClearing(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              icon="trash"
              disabled={clear.isPending}
              loading={clear.isPending}
              onClick={() =>
                clear.mutate(
                  { channelId },
                  {
                    onSuccess: () => {
                      toast.show(t("dm.cleared"));
                      setClearing(false);
                    },
                  },
                )
              }
            >
              {t("dm.clearConversation")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}

/** `entry` at the end of a list's first group (before its first separator). */
function withEntry(entries: MenuEntry[], entry: MenuEntry): MenuEntry[] {
  const at = entries.findIndex((e) => e.kind === "separator");
  return at < 0 ? [...entries, entry] : [...entries.slice(0, at), entry, ...entries.slice(at)];
}
