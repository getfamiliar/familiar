import type * as React from "react";
import { AppBrand } from "@/components/app-brand";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarRail,
} from "@/components/ui/sidebar";
import type { Shell } from "@/hooks/use-shell";

/**
 * The app sidebar (collapses to icons): brand and version on top, the
 * plugins' menu in the middle, the signed-in user at the bottom.
 *
 * @param props.shell Shell data, or null while loading.
 * @param props.pathname Current page path.
 * @returns The sidebar.
 */
export function AppSidebar({
    shell,
    pathname,
    ...props
}: React.ComponentProps<typeof Sidebar> & {
    readonly shell: Shell | null;
    readonly pathname: string;
}) {
    return (
        <Sidebar collapsible="icon" {...props}>
            <SidebarHeader>
                <AppBrand version={shell?.version ?? null} />
            </SidebarHeader>
            <SidebarContent>
                <NavMain items={shell?.menu ?? []} pathname={pathname} />
            </SidebarContent>
            <SidebarFooter>{shell !== null && <NavUser user={shell.user} />}</SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
