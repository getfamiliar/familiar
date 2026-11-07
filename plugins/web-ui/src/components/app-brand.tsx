import { AvatarSvg } from "@getfamiliar/avatar";
import type { WebAssistantIdentity } from "@getfamiliar/shared";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/**
 * Top of the sidebar: the assistant's avatar (large; icon-sized in the
 * collapsed sidebar) and name. Links to the start page. The `!` sizes
 * override the menu button's `[&_svg]:size-4`.
 *
 * @param props.assistant The assistant, or null while loading.
 * @returns The brand row.
 */
export function AppBrand({ assistant }: { readonly assistant: WebAssistantIdentity | null }) {
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <SidebarMenuButton size="lg" className="h-auto gap-3 py-2" asChild>
                    <a href="/">
                        {assistant === null ? (
                            <div className="aspect-square size-16 shrink-0 rounded-xl bg-sidebar-primary group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg" />
                        ) : (
                            <AvatarSvg
                                config={assistant.avatar}
                                className="aspect-square size-16! shrink-0 rounded-xl group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:rounded-lg"
                            />
                        )}
                        <div className="grid flex-1 text-left text-sm leading-tight">
                            <span className="truncate font-semibold text-base">
                                {assistant?.name ?? " "}
                            </span>
                        </div>
                    </a>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
